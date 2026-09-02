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

const pdfjsBase = path.dirname(
  require.resolve("pdfjs-dist/package.json")
);

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
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || "";

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

const jobs = new Map();

let activeJobId = null;


/* =========================================================
   ADMIN AUTHENTICATION
   ========================================================= */

function adminAuth(req, res, next) {
  const suppliedPassword =
    req.get("x-admin-password");

  if (
    !ADMIN_PASSWORD ||
    suppliedPassword !== ADMIN_PASSWORD
  ) {
    return res
      .status(401)
      .json({
        error: "Invalid admin password."
      });
  }

  next();
}


/* =========================================================
   CONSUMER NUMBER CLEANING
   ========================================================= */

function cleanConsumer(value) {
  return String(value || "")
    .replace(/\D/g, "");
}


/* =========================================================
   CONSUMER NUMBER EXTRACTION
   ========================================================= */

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


  /* -------------------------------------------------------
     FALLBACK SEARCH
     ------------------------------------------------------- */

  const combined = candidates.join(" ");

  const lower = combined.toLowerCase();

  for (
    const marker of [
      "consumer no",
      "consumer number",
      "consumer no."
    ]
  ) {

    const markerIndex =
      lower.indexOf(marker);

    if (markerIndex >= 0) {

      const tail = combined.slice(
        markerIndex,
        markerIndex + 180
      );

      const numberMatch =
        tail.match(/\b\d{8,15}\b/);

      if (numberMatch) {

        return cleanConsumer(
          numberMatch[0]
        );

      }
    }
  }


  /* -------------------------------------------------------
     PGVCL 11-DIGIT FALLBACK
     ------------------------------------------------------- */

  const elevenDigitNumbers =
    combined.match(/\b\d{11}\b/g) || [];

  for (
    const number of elevenDigitNumbers
  ) {

    if (number.startsWith("347")) {

      return cleanConsumer(number);

    }
  }


  return null;
}


/* =========================================================
   SUPABASE - GET LATEST INDEX
   ========================================================= */

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
      String(error.message || "")
        .toLowerCase();

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


/* =========================================================
   SUPABASE - SAVE LATEST INDEX
   ========================================================= */

async function saveLatestIndex(index) {

  const body = Buffer.from(
    JSON.stringify(
      index,
      null,
      2
    ),
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
        contentType:
          "application/json",

        upsert: true,

        cacheControl: "60"
      }
    );


  if (error) {
    throw error;
  }
}


/* =========================================================
   SUPABASE - UPLOAD INDIVIDUAL BILL
   ========================================================= */

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
        contentType:
          "application/pdf",

        upsert: true,

        cacheControl:
          "31536000"
      }
    );


  if (error) {
    throw error;
  }


  return objectPath;
}


/* =========================================================
   SUPABASE - SIGNED BILL URL
   ========================================================= */

async function signedBillUrl(
  objectPath
) {

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


/* =========================================================
   PUBLIC JOB STATUS
   ========================================================= */

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
      job.failures?.length || 0,

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


/* =========================================================
   MONTHLY PDF PROCESSOR
   ========================================================= */

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

    job.status =
      "processing";

    job.message =
      "Reading master PDF...";


    /* -----------------------------------------------------
       READ PDF
       ----------------------------------------------------- */

    const buffer =
      await fs.promises.readFile(
        tempPath
      );


    const sourcePdf =
      await PDFDocument.load(
        buffer
      );


    const pdfData =
      new Uint8Array(buffer);


    /* -----------------------------------------------------
       PDF.JS CONFIGURATION
       ----------------------------------------------------- */

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


    job.pageCount =
      pdf.numPages;


    /* =====================================================
       IMPORTANT TEST SETTING
       
       ONLY FIRST 10 PAGES WILL BE PROCESSED.
       
       After testing we will change this back to:
       const TEST_PAGE_LIMIT = pdf.numPages;
       ===================================================== */

    const TEST_PAGE_LIMIT = 10;

    const pagesToProcess =
      Math.min(
        pdf.numPages,
        TEST_PAGE_LIMIT
      );


    job.message =
      `TEST MODE: Processing first ${pagesToProcess} of ${pdf.numPages} pages...`;


    console.log(
      `TEST MODE ENABLED: Processing first ${pagesToProcess} pages out of ${pdf.numPages}.`
    );


    /* -----------------------------------------------------
       GET EXISTING INDEX
       ----------------------------------------------------- */

    let index =
      await getLatestIndex();


    /* -----------------------------------------------------
       PROCESS PAGES
       ----------------------------------------------------- */

    for (
      let pageNo = 1;
      pageNo <= pagesToProcess;
      pageNo++
    ) {

      job.currentPage =
        pageNo;


      try {

        console.log(
          `Reading page ${pageNo}...`
        );


        /* -------------------------------------------------
           GET PAGE
           ------------------------------------------------- */

        const page =
          await pdf.getPage(
            pageNo
          );


        /* -------------------------------------------------
           GET TEXT
           ------------------------------------------------- */

        const content =
          await page.getTextContent();


        const strings =
          content.items.map(
            item =>
              String(
                item.str || ""
              )
          );


        const text =
          strings.join(" ");


        console.log(
          `PAGE ${pageNo} TEXT LENGTH:`,
          text.length
        );


        console.log(
          `PAGE ${pageNo} TEXT SAMPLE:`,
          text.slice(0, 500)
        );


        /* -------------------------------------------------
           EXTRACT CONSUMER NUMBER
           ------------------------------------------------- */

        const consumer =
          extractConsumerNo(
            text,
            strings
          );


        if (!consumer) {

          console.log(
            `PAGE ${pageNo}: NO CONSUMER NUMBER FOUND`
          );

          job.skipped++;

          continue;
        }


        console.log(
          `PAGE ${pageNo}: CONSUMER NUMBER = ${consumer}`
        );


        /* -------------------------------------------------
           CREATE ONE-PAGE PDF
           ------------------------------------------------- */

        const onePagePdf =
          await PDFDocument.create();


        const [
          copiedPage
        ] =
          await onePagePdf.copyPages(
            sourcePdf,
            [pageNo - 1]
          );


        onePagePdf.addPage(
          copiedPage
        );


        const onePageBytes =
          await onePagePdf.save();


        /* -------------------------------------------------
           UPLOAD TO SUPABASE
           ------------------------------------------------- */

        const objectPath =
          await uploadBill(
            month,
            consumer,
            onePageBytes
          );


        /* -------------------------------------------------
           UPDATE INDEX
           ------------------------------------------------- */

        index[consumer] = {

          month,

          path: objectPath,

          updatedAt:
            new Date()
              .toISOString()

        };


        job.processed++;


        console.log(
          `SUCCESS: Page ${pageNo} -> ${consumer}`
        );


        /* -------------------------------------------------
           SAVE INDEX
           ------------------------------------------------- */

        await saveLatestIndex(
          index
        );


        job.message =
          `TEST: Processed ${job.processed} bills from first ${pagesToProcess} pages.`;

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


    /* -----------------------------------------------------
       FINAL INDEX SAVE
       ----------------------------------------------------- */

    await saveLatestIndex(
      index
    );


    /* -----------------------------------------------------
       FINISH JOB
       ----------------------------------------------------- */

    if (job.processed === 0) {

      job.status =
        "failed";

      job.error =
        "No Consumer Numbers were found in the first 10 pages of the uploaded PDF.";

      job.message =
        job.error;

    } else {

      job.status =
        "done";

      job.message =
        `TEST SUCCESS: Found and processed ${job.processed} Consumer Numbers from the first ${pagesToProcess} pages.`;

    }


    job.finishedAt =
      new Date()
        .toISOString();


    console.log(
      `JOB ${jobId} FINISHED: ${job.processed} bills, ${job.skipped} skipped, ${job.failures.length} failed pages.`
    );


  } catch (err) {

    job.status =
      "failed";

    job.error =
      String(
        err.message || err
      );

    job.message =
      "Monthly PDF processing failed.";


    job.finishedAt =
      new Date()
        .toISOString();


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


/* =========================================================
   HEALTH CHECK
   ========================================================= */

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


/* =========================================================
   CONSUMER BILL API
   ========================================================= */

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
            "Unable to retrieve the bill right now."

        });

    }

  }
);


/* =========================================================
   DIRECT BILL PDF ROUTE
   ========================================================= */

app.get(
  "/api/bill/:month/:consumer.pdf",
  async (req, res) => {

    try {

      const consumer =
        cleanConsumer(
          req.params.consumer
        );


      const month =
        req.params.month;


      if (
        !/^\d{4}-\d{2}$/.test(
          month
        ) ||
        !/^\d{8,15}$/.test(
          consumer
        )
      ) {

        return res
          .status(400)
          .send(
            "Invalid request."
          );

      }


      const url =
        await signedBillUrl(
          `${month}/${consumer}.pdf`
        );


      res.redirect(url);


    } catch (err) {

      console.error(err);


      res
        .status(404)
        .send(
          "Bill not found."
        );

    }

  }
);


/* =========================================================
   ADMIN - UPLOAD MASTER PDF
   ========================================================= */

app.post(
  "/api/admin/upload",
  adminAuth,
  upload.single("pdf"),
  async (req, res) => {

    let tempPath = null;


    try {

      if (!req.file) {

        return res
          .status(400)
          .json({

            error:
              "Please upload a master PDF."

          });

      }


      const month =
        String(
          req.body.month || ""
        ).trim();


      if (
        !/^\d{4}-\d{2}$/.test(
          month
        )
      ) {

        return res
          .status(400)
          .json({

            error:
              "Bill month must be YYYY-MM."

          });

      }


      if (activeJobId) {

        return res
          .status(409)
          .json({

            error:
              "Another PDF is already being processed.",

            jobId:
              activeJobId

          });

      }


      tempPath =
        req.file.path;


      const jobId =
        crypto.randomUUID();


      jobs.set(
        jobId,
        {

          id: jobId,

          status:
            "queued",

          month,

          pageCount: 0,

          currentPage: 0,

          processed: 0,

          skipped: 0,

          failures: [],

          startedAt:
            new Date()
              .toISOString()

        }
      );


      activeJobId =
        jobId;


      const jobTempPath =
        tempPath;


      tempPath = null;


      /* ---------------------------------------------------
         START BACKGROUND PROCESSING
         --------------------------------------------------- */

      processMonthlyPdf(
        jobId,
        jobTempPath,
        month
      ).catch(
        err =>
          console.error(
            "Background processor error:",
            err
          )
      );


      res.json({

        ok: true,

        jobId,

        message:
          "Processing started. You can keep this page open to watch progress."

      });


    } catch (err) {

      console.error(err);


      if (tempPath) {

        try {

          await fs.promises.unlink(
            tempPath
          );

        } catch {}

      }


      res
        .status(500)
        .json({

          error:
            "Unable to start monthly PDF processing.",

          details:
            String(
              err.message || err
            )

        });

    }

  }
);


/* =========================================================
   ADMIN - JOB PROGRESS
   ========================================================= */

app.get(
  "/api/admin/progress/:jobId",
  adminAuth,
  (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );


    if (!job) {

      return res
        .status(404)
        .json({

          error:
            "Processing job not found. It may have been lost after a server restart."

        });

    }


    res.json({

      ok: true,

      job:
        publicJob(job)

    });

  }
);


/* =========================================================
   ADMIN - CURRENT JOB
   ========================================================= */

app.get(
  "/api/admin/current",
  adminAuth,
  (req, res) => {

    const job =
      activeJobId
        ? jobs.get(activeJobId)
        : null;


    res.json({

      ok: true,

      job:
        job
          ? publicJob(job)
          : null

    });

  }
);


/* =========================================================
   ADMIN PAGE
   ========================================================= */

app.get(
  "/admin",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );

  }
);


/* =========================================================
   STATIC FILES
   ========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* =========================================================
   START SERVER
   ========================================================= */

const PORT =
  Number(
    process.env.PORT || 10000
  );


app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `PGVCL Bill Finder running on port ${PORT}`
    );

  }
);
