import { serve } from "bun";
import puppeteer, { Browser } from "puppeteer";
import crypto from "crypto";
import { Database } from "bun:sqlite";

let browser: Browser | null = null;
let browserCreationTime: number = 0;
const BROWSER_LIFETIME = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

const PDF_GENERATION_TIMEOUT = parseInt(
  process.env.PDF_GENERATION_TIMEOUT || "30000"
);
const BROWSER_LAUNCH_TIMEOUT = parseInt(
  process.env.BROWSER_LAUNCH_TIMEOUT || "60000"
);

// Concurrency management
const MAX_CONCURRENT_TASKS = 6;
let runningTasks = 0;
const taskQueue: (() => Promise<void>)[] = [];

const API_KEY = process.env.API_KEY;
console.log(`API_KEY present: ${!!API_KEY}`);

// Create or open the SQLite database
const db = new Database(process.env.DB_PATH || "mr_stats.sqlite");
console.log("Database created/opened");

// Initialize the database schema
db.run(`
  CREATE TABLE IF NOT EXISTS pdf_counters (
    date TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
  )
`);
console.log("Database schema initialized");

// Function to increment the PDF counter
function incrementPDFCounter() {
  const date = new Date().toISOString().split("T")[0];
  db.run(
    "INSERT OR REPLACE INTO pdf_counters (date, count) VALUES (?, COALESCE((SELECT count FROM pdf_counters WHERE date = ?) + 1, 1))",
    [date, date]
  );
}

// Function to get total PDFs generated
function getTotalPDFsGenerated(): number {
  const result = db
    .query("SELECT SUM(count) as total FROM pdf_counters")
    .get() as { total: number | null };
  return result && result.total !== null ? result.total : 0;
}

async function runTask<T>(task: () => Promise<T>): Promise<T> {
  if (runningTasks >= MAX_CONCURRENT_TASKS) {
    await new Promise<void>((resolve) =>
      taskQueue.push(() => {
        resolve();
        return Promise.resolve();
      })
    );
  }

  runningTasks++;
  try {
    return await task();
  } finally {
    runningTasks--;
    if (taskQueue.length > 0) {
      const nextTask = taskQueue.shift();
      nextTask?.();
    }
  }
}

async function getBrowser(): Promise<Browser> {
  const currentTime = Date.now();
  if (!browser || currentTime - browserCreationTime > BROWSER_LIFETIME) {
    if (browser) {
      await browser.close();
    }
    browser = await puppeteer.launch({
      headless: "shell",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--single-process",
      ],
      timeout: BROWSER_LAUNCH_TIMEOUT,
    });
    browserCreationTime = currentTime;
  }
  return browser;
}

async function generatePDFWithTimeout(html: string): Promise<Buffer> {
  return runTask(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      await Promise.race([
        page.setContent(html, { waitUntil: "networkidle0" }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("PDF generation timeout")),
            PDF_GENERATION_TIMEOUT
          )
        ),
      ]);

      const pdf = await page.pdf({
        format: "a4",
        margin: {
          top: "0px",
          right: "0px",
          bottom: "0px",
          left: "0px",
        },
      });

      return Buffer.from(pdf);
    } catch (error) {
      console.error("Error in PDF generation:", error);
      throw error;
    } finally {
      await page.close();
    }
  });
}

function validateRequest(req: Request): boolean {
  const apiKey = req.headers.get("X-API-Key");
  const timestamp = req.headers.get("X-Timestamp");
  const signature = req.headers.get("X-Signature");

  if (!apiKey || apiKey !== API_KEY || !timestamp || !signature) {
    console.log("Request validation failed: Invalid headers");
    return false;
  }

  // Check if the timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    console.log("Request validation failed: Timestamp out of range");
    return false;
  }

  // Verify the signature
  const computedSignature = crypto
    .createHmac("sha256", API_KEY)
    .update(`${timestamp}/`)
    .digest("hex");

  if (computedSignature !== signature) {
    console.log("Request validation failed: Invalid signature");
    return false;
  }

  return true;
}

const server = serve({
  port: 5000,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`\n--- New Request ---`);
    console.log(`Received ${req.method} request for ${url.pathname}`);

    // Normalize the path by removing leading slashes and converting to lowercase
    const normalizedPath = url.pathname.replace(/^\/+/, "").toLowerCase();

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, X-API-Key, X-Timestamp, X-Signature",
        },
      });
    }

    if (
      req.method === "GET" &&
      (normalizedPath === "pdf-count" || normalizedPath === "")
    ) {
      if (!validateRequest(req)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      try {
        const totalPDFs = getTotalPDFsGenerated();
        return new Response(JSON.stringify({ count: totalPDFs }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (error) {
        console.error("Error getting PDF count:", error);
        return new Response(
          JSON.stringify({ error: "Internal Server Error" }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    if (
      req.method === "POST" &&
      (normalizedPath === "pdf-count" ||
        normalizedPath === "generate-pdf" ||
        normalizedPath === "")
    ) {
      if (!validateRequest(req)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const { html } = await req.json();
        const pdf = await generatePDFWithTimeout(html);
        incrementPDFCounter();
        const totalPDFs = getTotalPDFsGenerated();

        const chunkSize = 16384; // 16KB chunks
        const totalChunks = Math.ceil(pdf.length / chunkSize);

        const stream = new ReadableStream({
          start(controller) {
            for (let i = 0; i < pdf.length; i += chunkSize) {
              controller.enqueue(pdf.slice(i, i + chunkSize));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment; filename=resume.pdf",
            "X-Total-PDFs-Generated": totalPDFs.toString(),
            "Content-Length": pdf.length.toString(),
            "Access-Control-Allow-Origin": "*",
            "Transfer-Encoding": "chunked",
          },
        });
      } catch (error) {
        console.error("Error generating PDF:", error);
        if (
          error instanceof Error &&
          error.message === "PDF generation timeout"
        ) {
          return new Response(
            JSON.stringify({ error: "PDF generation timed out" }),
            {
              status: 504,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }
        return new Response(
          JSON.stringify({ error: "Failed to generate PDF" }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
});

console.log(`PDF generation service listening on ${server.port}`);

// Cleanup function
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing browser and database, then exiting");
  if (browser) {
    await browser.close();
  }
  db.close();
  process.exit(0);
});

// Periodic browser recreation
setInterval(async () => {
  if (browser && Date.now() - browserCreationTime > BROWSER_LIFETIME) {
    const oldBrowser = browser;
    browser = null; // Reset browser to null to trigger creation of a new one
    await oldBrowser.close(); // Close the old browser
  }
}, 60 * 60 * 1000); // Check every hour
