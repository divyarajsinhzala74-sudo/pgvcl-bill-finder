import express from "express";
import multer from "multer";
import Database from "better-sqlite3";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  console.warn("WARNING: SUPABASE_URL or SUPABASE_SECRET_KEY is missing.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 50 * 1024 * 1024 }
});

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD || req.get("x-admin-password") !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid admin password." });
  }
  next();
}

function cleanConsumer(value) {
  return String(value || "").replace(/\D/g, "");
}

function extractConsumerNo(text) {
  const patterns = [
    /Consumer\s*No\s*[:\-]?\s*(\d{8,15})/i,
    /Consumer\s*Number\s*[:\-]?\s*(\d{8,15})/i,
    /Consumer\s*No\.\s*[:\-]?\s*(\d{8,15})/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return cleanConsumer(m[1]);
  }
  return null;
}

async function getLatestIndex() {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .download("index/latest.json");

  if (error) {
    if (error.message?.toLowerCase().includes("not found")) return {};
    throw error;
  }

  const text = Buffer.from(await data.arrayBuffer()).toString("utf8");
  return JSON.parse(text || "{}");
}

async function saveLatestIndex(index) {
  const body = Buffer.from(JSON.stringify(index, null, 2), "utf8");
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload("index/latest.json", body, {
      contentType: "application/json",
      upsert: true,
      cacheControl: "60"
    });

  if (error) throw error;
}

async function uploadBill(month, consumer, bytes) {
  const objectPath = `${month}/${consumer}.pdf`;

  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(objectPath, bytes, {
      contentType: "application/pdf",
      upsert: true,
      cacheControl: "31536000"
    });

  if (error) throw error;
  return objectPath;
}

async function signedBillUrl(objectPath) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(objectPath, 300);

  if (error) throw error;
  return data.signedUrl;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY)
  });
});

app.get("/api/bill", async (req, res) => {
  try {
    const consumer = cleanConsumer(req.query.consumer);

    if (!/^\d{8,15}$/.test(consumer)) {
      return res.status(400).json({ error: "Enter a valid Consumer Number." });
    }

    const index = await getLatestIndex();
    const record = index[consumer];

    if (!record?.path) {
      return res.status(404).json({ error: "Bill not found for this Consumer Number." });
    }

    const url = await signedBillUrl(record.path);

    res.json({
      ok: true,
      consumer,
      month: record.month,
      url
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to retrieve the bill right now." });
  }
});

app.get("/api/bill/:month/:consumer.pdf", async (req, res) => {
  try {
    const consumer = cleanConsumer(req.params.consumer);
    const month = req.params.month;

    if (!/^\d{4}-\d{2}$/.test(month) || !/^\d{8,15}$/.test(consumer)) {
      return res.status(400).send("Invalid request.");
    }

    const url = await signedBillUrl(`${month}/${consumer}.pdf`);
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(404).send("Bill not found.");
  }
});

app.post("/api/admin/upload", adminAuth, upload.single("pdf"), async (req, res) => {
  let tempPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload a master PDF." });
    }

    const month = String(req.body.month || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "Bill month must be YYYY-MM." });
    }

    tempPath = req.file.path;

    const buffer = await fs.promises.readFile(tempPath);
    const sourcePdf = await PDFDocument.load(buffer);
    const pdfData = new Uint8Array(buffer);

    const loadingTask = pdfjsLib.getDocument({
      data: pdfData,
      disableWorker: true,
      useWorkerFetch: false,
      isEvalSupported: false
    });

    const pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;

    const newIndex = {};
    let processed = 0;
    let skipped = 0;
    const failures = [];

    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      try {
        const page = await pdf.getPage(pageNo);
        const content = await page.getTextContent();
        const text = content.items.map(item => item.str || "").join(" ");
        const consumer = extractConsumerNo(text);

        if (!consumer) {
          skipped++;
          continue;
        }

        const onePagePdf = await PDFDocument.create();
        const [copiedPage] = await onePagePdf.copyPages(sourcePdf, [pageNo - 1]);
        onePagePdf.addPage(copiedPage);
        const onePageBytes = await onePagePdf.save();

        const objectPath = await uploadBill(month, consumer, onePageBytes);

        newIndex[consumer] = {
          month,
          path: objectPath,
          updatedAt: new Date().toISOString()
        };

        processed++;
      } catch (pageError) {
        console.error(`Page ${pageNo} failed:`, pageError);
        failures.push({ page: pageNo, error: String(pageError.message || pageError) });
      }
    }

    if (processed === 0) {
      return res.status(422).json({
        error: "No Consumer Numbers were found in the uploaded PDF.",
        pageCount,
        skipped,
        failures: failures.slice(0, 20)
      });
    }

    // Preserve older consumers while replacing/updating consumers found in this month.
    const oldIndex = await getLatestIndex();
    const mergedIndex = { ...oldIndex, ...newIndex };
    await saveLatestIndex(mergedIndex);

    res.json({
      ok: true,
      month,
      pageCount,
      processed,
      skipped,
      failedPages: failures.length,
      message: `Successfully processed ${processed} bills for ${month}.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Monthly PDF processing failed.",
      details: String(err.message || err)
    });
  } finally {
    if (tempPath) {
      try { await fs.promises.unlink(tempPath); } catch {}
    }
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`PGVCL Bill Finder running on port ${PORT}`);
});
