import express from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const BILLS = path.join(DATA, 'bills');
fs.mkdirSync(BILLS, {recursive:true});
const db = new Database(path.join(DATA,'pgvcl.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS bills (id INTEGER PRIMARY KEY, consumer_no TEXT NOT NULL, bill_month TEXT NOT NULL, name TEXT, source_file TEXT, page_no INTEGER, pdf_path TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(consumer_no,bill_month));`);

const app = express();
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));
const upload = multer({dest:path.join(DATA,'uploads'), limits:{fileSize:50*1024*1024}});
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE-ME';

function auth(req,res,next){
  if(req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({error:'Unauthorized'});
  next();
}
function clean(s){return (s||'').replace(/\D/g,'');}
function extractConsumer(text){const m=text.match(/Consumer\s*No\s*:\s*(\d{6,20})/i); return m?m[1]:null;}
function extractName(text){
  const m=text.match(/(?:District:[^|\n]+\s+)?([A-Z][A-Z .&'\-]{2,80})\s+\d{6,20}\s+Village:/i);
  return m?m[1].trim():'';
}
async function processPdf(file, billMonth){
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await pdfjsLib.getDocument({data}).promise;
  const src = await PDFDocument.load(data);
  let count=0;
  const rows=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p); const tc=await page.getTextContent();
    const text=tc.items.map(x=>x.str).join(' ');
    const consumer=extractConsumer(text);
    if(!consumer) continue;
    const out=await PDFDocument.create(); const [copied]=await out.copyPages(src,[p-1]); out.addPage(copied);
    const safe=consumer.replace(/[^0-9]/g,'');
    const rel=path.join('bills',billMonth,`${safe}.pdf`); const abs=path.join(DATA,rel);
    fs.mkdirSync(path.dirname(abs),{recursive:true}); fs.writeFileSync(abs,await out.save());
    rows.push({consumer_no:consumer,bill_month:billMonth,name:extractName(text),source_file:path.basename(file),page_no:p,pdf_path:rel});
    count++;
  }
  const tx=db.transaction(()=>{
    for(const r of rows){
      db.prepare(`INSERT INTO bills(consumer_no,bill_month,name,source_file,page_no,pdf_path) VALUES(@consumer_no,@bill_month,@name,@source_file,@page_no,@pdf_path) ON CONFLICT(consumer_no,bill_month) DO UPDATE SET name=excluded.name,source_file=excluded.source_file,page_no=excluded.page_no,pdf_path=excluded.pdf_path,created_at=CURRENT_TIMESTAMP`).run(r);
    }
  }); tx();
  return {pages:pdf.numPages,found:count};
}

app.get('/api/latest', (req,res)=>{
  const row=db.prepare(`SELECT bill_month FROM bills ORDER BY bill_month DESC LIMIT 1`).get();
  res.json({bill_month:row?.bill_month||null});
});
app.get('/api/bill', (req,res)=>{
  const c=clean(req.query.consumer);
  if(c.length<6) return res.status(400).json({error:'Enter a valid Consumer Number.'});
  const row=db.prepare(`SELECT consumer_no,bill_month,name,page_no FROM bills WHERE consumer_no=? ORDER BY bill_month DESC LIMIT 1`).get(c);
  if(!row) return res.status(404).json({error:'Consumer Number not found.'});
  res.json({...row, pdf_url:`/api/bill/${row.bill_month}/${row.consumer_no}.pdf`});
});
app.get('/api/bill/:month/:consumer.pdf',(req,res)=>{
  const c=clean(req.params.consumer); const row=db.prepare(`SELECT pdf_path FROM bills WHERE consumer_no=? AND bill_month=?`).get(c,req.params.month);
  if(!row) return res.status(404).send('Bill not found');
  const abs=path.join(DATA,row.pdf_path); if(!fs.existsSync(abs)) return res.status(404).send('Bill file missing');
  res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition',`inline; filename="${c}_Bill.pdf"`); res.sendFile(abs);
});
app.get('/api/admin/stats',auth,(req,res)=>{res.json({bills:db.prepare('SELECT COUNT(*) c FROM bills').get().c, months:db.prepare('SELECT bill_month,COUNT(*) count FROM bills GROUP BY bill_month ORDER BY bill_month DESC').all()});});
app.post('/api/admin/upload',auth,upload.single('pdf'),async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'PDF is required.'});
    const month=(req.body.month||'').trim(); if(!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:'Month must be YYYY-MM.'});
    const result=await processPdf(req.file.path,month); fs.unlinkSync(req.file.path); res.json({ok:true,...result,bill_month:month});
  }catch(e){console.error(e); try{if(req.file?.path)fs.unlinkSync(req.file.path)}catch{} res.status(500).json({error:e.message});}
});
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.listen(process.env.PORT||3000,()=>console.log('PGVCL Bill Finder V3 running'));
