import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

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

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.warn(
    "WARNING: SUPABASE_URL or SUPABASE_SECRET_KEY is missing."
  );
}

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

function adminAuth(req, res, next) {
  const suppliedPassword = req.get("x-admin-password");

  if (
    !ADMIN_PASSWORD ||
    suppliedPassword !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Invalid admin password."
    });
  }

  next();
}

function cleanConsumer(value) {
  return String(value || "").replace(/\D/g, "");
}

/*
  PGVCL PDFs can place the label and number in different
  text items. Therefore we try several versions of the
  extracted text instead of relying on one exact string.
*/
function extractConsumerNo(text, strings = []) {
  const candidates = [
    String(text || ""),
    strings.join(""),
    strings.join(" ")
  ];

  for (const candidate of candidates) {
    const normalized = candidate
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ");

    const patterns = [
      /Consumer\s*No\s*[:：\-]?\s*(\d{8,15})/i,
      /Consumer\s*Number\s*[:：\-]?\s*(\d{8,15})/i,
      /Consumer\s*No\.\s*[:：\-]?\s*(\d{8,15})/i
    ];

    for (const re of patterns) {
      const match = normalized.match(re);

      if (match) {
        return cleanConsumer(match[1]);
      }
    }
  }

  /*
    Fallback:
    If PDF.js separates "Consumer No" from the number,
    look near the label for any 8-15 digit number.
  */
  const combined = candidates.join(" ");
  const lower = combined.toLowerCase();

  const markers = [
    "consumer no",
    "consumer number",
    "consumer no."
  ];

  for (const marker of markers) {
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

  /*
    Last fallback for the PGVCL format:
    Consumer numbers are normally 11 digits.
    The older working extractor also used 3477-prefixed
    numbers as a fallback.
  */
  const elevenDigitNumbers =
    combined.match(/\b\d{11}\b/g) || [];

  for (const number of elevenDigitNumbers) {
    if (number.startsWith("347")) {
      return cleanConsumer(number);
    }
  }

  return null;
}

async function getLatestIndex() {
  const { data, error } =
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .download("index/latest.json");

  if (error) {
    const message = String(error.message || "").toLowerCase();

    if (
      message.includes("not found") ||
      message.includes("404")
    ) {
      return {};
    }

    throw error;
  }

  const text = Buffer
    .from(await data.arrayBuffer())
    .toString("utf8");

  return JSON.parse(text || "{}");
}

async function saveLatestIndex(index) {
  const body = Buffer.from(
    JSON.stringify(index, null, 2),
    "utf8"
  );

  const { error } =
    await supabase.storage
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

async function uploadBill(month, consumer, bytes) {
  const objectPath =
    `${month}/${consumer}.pdf`;

  const { error } =
    await supabase.storage
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

async function signedBillUrl(objectPath) {
  const { data, error } =
    await supabase.storage
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    supabaseConfigured:
      Boolean(
        SUPABASE_URL &&
        SUPABASE_SECRET_KEY
      )
  });
});

app.get("/api/bill", async (req, res) => {
  try {
    const consumer =
      cleanConsumer(req.query.consumer);

    if (!/^\d{8,15}$/.test(consumer)) {
      return res.status(400).json({
        error:
          "Enter a valid Consumer Number."
      });
    }

    const index =
      await getLatestIndex();

    const record = index[consumer];

    if (!record || !record.path) {
      return res.status(404).json({
        error:
          "Bill not found for this Consumer Number."
      });
    }

    const url =
      await signedBillUrl(record.path);

    res.json({
      ok: true,
      consumer,
      month: record.month,
      url
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error:
        "Unable to retrieve the bill right now."
    });
  }
});

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
        !/^\d{4}-\d{2}$/.test(month) ||
        !/^\d{8,15}$/.test(consumer)
      ) {
        return res.status(400).send(
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

      res.status(404).send(
        "Bill not found."
      );
    }
  }
);

app.post(
  "/api/admin/upload",
  adminAuth,
  upload.single("pdf"),
  async (req, res) => {
    let tempPath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "Please upload a master PDF."
        });
      }

      const month =
        String(
          req.body.month || ""
        ).trim();

      if (
        !/^\d{4}-\d{2}$/.test(month)
      ) {
        return res.status(400).json({
          error:
            "Bill month must be YYYY-MM."
        });
      }

      tempPath = req.file.path;

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

      /*
        PDF.js configuration for Node.
        CMaps and standard fonts are supplied explicitly.
        This is important for PDFs where getTextContent()
        otherwise returns incomplete/empty text.
      */
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

      const pageCount =
        pdf.numPages;

      const newIndex = {};

      let processed = 0;
      let skipped = 0;

      const failures = [];

      for (
        let pageNo = 1;
        pageNo <= pageCount;
        pageNo++
      ) {
        try {
          const page =
            await pdf.getPage(
              pageNo
            );

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

          /*
            Temporary diagnostic logging for page 1.
            This helps verify PDF.js text extraction
            in Render logs.
          */
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
            skipped++;
            continue;
          }

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

          newIndex[consumer] = {
            month,
            path: objectPath,
            updatedAt:
              new Date().toISOString()
          };

          processed++;

          if (
            processed % 25 === 0
          ) {
            console.log(
              `Processed ${processed} bills...`
            );
          }
        } catch (pageError) {
          console.error(
            `Page ${pageNo} failed:`,
            pageError
          );

          failures.push({
            page: pageNo,
            error:
              String(
                pageError.message ||
                pageError
              )
          });
        }
      }

      if (processed === 0) {
        return res.status(422).json({
          error:
            "No Consumer Numbers were found in the uploaded PDF.",
          pageCount,
          skipped,
          failures:
            failures.slice(0, 20)
        });
      }

      /*
        Keep older consumers in the latest index.
        Consumers found in the new month replace
        their previous entry.
      */
      const oldIndex =
        await getLatestIndex();

      const mergedIndex = {
        ...oldIndex,
        ...newIndex
      };

      await saveLatestIndex(
        mergedIndex
      );

      res.json({
        ok: true,
        month,
        pageCount,
        processed,
        skipped,
        failedPages:
          failures.length,
        message:
          `Successfully processed ${processed} bills for ${month}.`
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Monthly PDF processing failed.",
        details:
          String(
            err.message || err
          )
      });
    } finally {
      if (tempPath) {
        try {
          await fs.promises.unlink(
            tempPath
          );
        } catch {}
      }
    }
  }
);

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

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

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
