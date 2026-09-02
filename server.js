import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const pdfjsBase = path.dirname(require.resolve("pdfjs-dist/package.json"));

const cMapUrl = path.join(pdfjsBase, "cmaps") + path.sep;
const standardFontDataUrl =
  path.join(pdfjsBase, "standard_fonts") + path.sep;

const app = express();
app.use(express.json());

const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");

fs.mkdirSync(UPLOADS, { recursive: true });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";

const SUPABASE_BUCKET = "bills";

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

const upload = multer({
  dest: UPLOADS,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

/* -------------------------------------------------------
   JOB MANAGEMENT
------------------------------------------------------- */

const jobs = new Map();
let activeJobId = null;

/* -------------------------------------------------------
   ADMIN AUTH
------------------------------------------------------- */

function adminAuth(req, res, next) {
  const suppliedPassword = req.get("x-admin-password");

  if (!ADMIN_PASSWORD || suppliedPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Invalid admin password."
    });
  }

  next();
}

/* -------------------------------------------------------
   CONSUMER NUMBER
------------------------------------------------------- */

function cleanConsumer(value) {
  return String(value || "").replace(/\D/g, "");
}

function extractConsumerNo(text, strings = []) {

  const candidates = [
    String(text || ""),
    strings.join(""),
    strings.join(" ")
  ];

  const patterns = [
    /Consumer\s*No\s*[:：\-]?\s*(\d{8,15})/i,
    /Consumer\s*Number\s*[:：\-]?\s*(\d{8,15})/i,
    /Consumer\s*No\.\s*[:：\-]?\s*(\d{8,15})/i
  ];

  for (const candidate of candidates) {

    const normalized = candidate
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ");

    for (const re of patterns) {

      const match = normalized.match(re);

      if (match) {
        return cleanConsumer(match[1]);
      }
    }
  }

  const combined = candidates.join(" ");
  const lower = combined.toLowerCase();

  for (const marker of [
    "consumer no",
    "consumer number",
    "consumer no."
  ]) {

    const markerIndex = lower.indexOf(marker);

    if (markerIndex >= 0) {

      const tail = combined.slice(
        markerIndex,
        markerIndex + 180
      );

      const numberMatch = tail.match(/\b\d{8,15}\b/);

      if (numberMatch) {
        return cleanConsumer(numberMatch[0]);
      }
    }
  }

  /* PGVCL consumer numbers commonly start with 347 */
  const elevenDigitNumbers =
    combined.match(/\b\d{11}\b/g) || [];

  for (const number of elevenDigitNumbers) {

    if (number.startsWith("347")) {
      return cleanConsumer(number);
    }
  }

  return null;
}

/* -------------------------------------------------------
   SUPABASE INDEX
------------------------------------------------------- */

async function getLatestIndex() {

  const {
    data,
    error
  } = await supabase
    .storage
    .from(SUPABASE_BUCKET)
    .download("index/latest.json");

  if (error) {

    const message =
      String(error.message || "").toLowerCase();

    if (
      message.includes("not found") ||
      message.includes("404") ||
      message.includes("no such object")
    ) {
      return {};
    }

    throw error;
  }

  const text =
    Buffer
      .from(await data.arrayBuffer())
      .toString("utf8");

  return JSON.parse(text || "{}");
}

async function saveLatestIndex(index) {

  const body =
    Buffer.from(
      JSON.stringify(index, null, 2),
      "utf8"
    );

  const {
    error
  } = await supabase
    .storage
    .from(SUPABASE_BUCKET)
    .upload(
      "index/latest.json",
      body,
      {
        contentType: "application/json",
        upsert: true,
        cacheControl: "60"
      }
    );

  if (error) {
    throw error;
  }
}

/* -------------------------------------------------------
   UPLOAD INDIVIDUAL BILL
------------------------------------------------------- */

async function uploadBill(
  month,
  consumer,
  bytes
) {

  const objectPath =
    `${month}/${consumer}.pdf`;

  const {
    error
  } = await supabase
    .storage
    .from(SUPABASE_BUCKET)
    .upload(
      objectPath,
      bytes,
      {
        contentType: "application/pdf",
        upsert: true,
        cacheControl: "31536000"
      }
    );

  if (error) {
    throw error;
  }

  return objectPath;
}

/* -------------------------------------------------------
   SIGNED BILL URL
------------------------------------------------------- */

async function signedBillUrl(objectPath) {

  const {
    data,
    error
  } = await supabase
    .storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(
      objectPath,
      300
    );

  if (error) {
    throw error;
  }

  return data.signedUrl;
}

/* -------------------------------------------------------
   PUBLIC JOB STATUS
------------------------------------------------------- */

function publicJob(job) {

  return {
    id: job.id,
    status: job.status,
    month: job.month,

    pageCount:
      job.pageCount || 0,

    currentPage:
      job.currentPage || 0,

    processed:
      job.processed || 0,

    skipped:
      job.skipped || 0,

    failedPages:
      job.failures
        ? job.failures.length
        : 0,

    startedAt:
      job.startedAt,

    finishedAt:
      job.finishedAt || null,

    error:
      job.error || null,

    message:
      job.message || null
  };
}

/* -------------------------------------------------------
   BACKGROUND PDF PROCESSOR
------------------------------------------------------- */

async function processMonthlyPdf(
  jobId,
  tempPath,
  month
) {

  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  try {

    job.status = "processing";
    job.message = "Reading master PDF...";

    const buffer =
      await fs.promises.readFile(tempPath);

    const sourcePdf =
      await PDFDocument.load(buffer);

    const pdfData =
      new Uint8Array(buffer);

    const loadingTask =
      pdfjsLib.getDocument({
        data: pdfData,

        cMapUrl,
        cMapPacked: true,

        standardFontDataUrl,

        disableWorker: true,

        useWorkerFetch: false,

        useSystemFonts: true,

        isEvalSupported: true
      });

    const pdf =
      await loadingTask.promise;

    /* IMPORTANT:
       This automatically detects the actual
       number of pages in each month's PDF.
       It is NOT fixed to 876.
    */

    job.pageCount =
      pdf.numPages;

    job.message =
      `Processing ${pdf.numPages} pages...`;

    let index =
      await getLatestIndex();

    for (
      let pageNo = 1;
      pageNo <= pdf.numPages;
      pageNo++
    ) {

      job.currentPage =
        pageNo;

      try {

        const page =
          await pdf.getPage(pageNo);

        const content =
          await page.getTextContent();

        const strings =
          content.items.map(
            item => String(item.str || "")
          );

        const text =
          strings.join(" ");

        if (pageNo === 1) {

          console.log(
            "PAGE 1 TEXT LENGTH:",
            text.length
          );

          console.log(
            "PAGE 1 TEXT SAMPLE:",
            text.slice(0, 700)
          );
        }

        const consumer =
          extractConsumerNo(
            text,
            strings
          );

        if (!consumer) {

          job.skipped++;

          continue;
        }

        /* Create a PDF containing only this page */

        const onePagePdf =
          await PDFDocument.create();

        const [copiedPage] =
          await onePagePdf.copyPages(
            sourcePdf,
            [pageNo - 1]
          );

        onePagePdf.addPage(
          copiedPage
        );

        const onePageBytes =
          await onePagePdf.save();

        const objectPath =
          await uploadBill(
            month,
            consumer,
            onePageBytes
          );

        index[consumer] = {

          month,

          path:
            objectPath,

          updatedAt:
            new Date().toISOString()
        };

        job.processed++;

        /* Save progress every 25 bills */

        if (
          job.processed % 25 === 0
        ) {

          await saveLatestIndex(
            index
          );

          console.log(
            `Processed ${job.processed} bills...`
          );

          job.message =
            `Processed ${job.currentPage} of ${job.pageCount} pages. ` +
            `${job.processed} bills saved.`;
        }

      } catch (pageError) {

        job.failures.push({
          page: pageNo,

          error:
            String(
              pageError.message ||
              pageError
            )
        });

        console.error(
          `Page ${pageNo} failed:`,
          pageError
        );
      }
    }

    /* Final save */

    await saveLatestIndex(index);

    if (job.processed === 0) {

      job.status = "failed";

      job.error =
        "No Consumer Numbers were found in the uploaded PDF.";

      job.message =
        job.error;

    } else {

      job.status = "done";

      job.message =
        `Successfully processed ${job.processed} bills for ${month}.`;
    }

    job.finishedAt =
      new Date().toISOString();

    console.log(
      `JOB ${jobId} FINISHED: ` +
      `${job.processed} bills, ` +
      `${job.skipped} skipped, ` +
      `${job.failures.length} failed pages.`
    );

  } catch (err) {

    job.status = "failed";

    job.error =
      String(
        err.message ||
        err
      );

    job.message =
      "Monthly PDF processing failed.";

    job.finishedAt =
      new Date().toISOString();

    console.error(
      `JOB ${jobId} FAILED:`,
      err
    );

  } finally {

    try {
      await fs.promises.unlink(
        tempPath
      );
    } catch {}

    if (
      activeJobId === jobId
    ) {
      activeJobId = null;
    }
  }
}

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,

      supabaseConfigured:
        Boolean(
          SUPABASE_URL &&
          SUPABASE_SECRET_KEY
        )
    });
  }
);

/* -------------------------------------------------------
   FIND BILL
------------------------------------------------------- */

app.get(
  "/api/bill",
  async (req, res) => {

    try {

      const consumer =
        cleanConsumer(
          req.query.consumer
        );

      if (
        !/^\d{8,15}$/.test(
          consumer
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              "Enter a valid Consumer Number."
          });
      }

      const index =
        await getLatestIndex();

      const record =
        index[consumer];

      if (
        !record ||
        !record.path
      ) {

        return res
          .status(404)
          .json({
            error:
              "Bill not found for this Consumer Number."
          });
      }

      const url =
        await signedBillUrl(
          record.path
        );

      res.json({
        ok: true,

        consumer,

        month:
          record.month,

        url
      });

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .json({
          error:
      res
          .status(500)
          .json({
            error:
              "Unable to retrieve the bill right now."
          });
