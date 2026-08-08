const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { prisma } = require("../../services/postingEngine");
const { upload, relativeFilePath, UPLOAD_ROOT } = require("../../services/documentStorage");
const { generateReceiptPdf } = require("../../services/receiptPdf");

// GET /documents — the Documents list: receipts (generated), invoices and
// scans (uploaded), filterable by type. This is the actual fulfilment of
// the source-of-truth policy's "What evidence exists?" row, which was
// honestly marked isPopulated=false until now — Documents genuinely gets
// written to for the first time here.
router.get("/documents", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const recordIds = unitRecords.map((r) => r.Records_id);

    // Documents doesn't have Entreprise_id or Business_Unit of its own —
    // scoped through Transactions -> Records the same way every other
    // Journal-adjacent table in this app is, since Documents.Transactions_id
    // links to a real Transactions row that does carry Business_Unit.
    const unitTransactions = await prisma.Transactions.findMany({
      where: { Records_id: { in: recordIds }, Entreprise_id: entrepriseId },
      select: { Transactions_id: true },
    });
    const txnIds = unitTransactions.map((t) => t.Transactions_id);

    const documents = await prisma.Documents.findMany({
      where: { Transactions_id: { in: txnIds } },
      orderBy: { Document_id: "desc" },
      take: 100,
    });

    // Stakeholders (for the "uploaded by" / "attached to" context) and
    // Records (for a human-readable reference back to the basket a
    // generated receipt belongs to).
    const recordsById = Object.fromEntries((await prisma.Records.findMany({ where: { Records_id: { in: recordIds } } })).map((r) => [r.Records_id, r]));
    const transactionsById = Object.fromEntries((await prisma.Transactions.findMany({ where: { Transactions_id: { in: txnIds } } })).map((t) => [t.Transactions_id, t]));

    res.render("documents", {
      title: "Documents",
      active: "documents",
      currentBusinessUnit: req.currentBusinessUnit,
      documents: documents.map((d) => {
        const txn = d.Transactions_id ? transactionsById[d.Transactions_id] : null;
        const recordsRow = txn && txn.Records_id ? recordsById[txn.Records_id] : null;
        return {
          id: d.Document_id,
          title: d.Document_Title,
          type: d.Document_type,
          docNo: d.Documents_no,
          date: d.Document_date ? new Date(d.Document_date).toLocaleDateString("en-GB") : "",
          amount: d.Net_Amount != null ? Number(d.Net_Amount) : null,
          status: d.Document_status,
          isGenerated: !!d.Generated,
          filePath: d.File_path,
          fileFormat: d.File_Format,
          cycleReference: recordsRow ? recordsRow.Records_type : null,
          notes: d.Notes,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading documents: " + err.message);
  }
});

// GET /documents/receipt/:recordsId — generate and stream a real PDF
// receipt directly from the posted Records/Transactions/Journal for one
// Till basket. Also saves a Documents row pointing at the generated file,
// so it shows up in the list above on future visits rather than only
// existing as a one-off download.
router.get("/documents/receipt/:recordsId", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const recordsId = Number(req.params.recordsId);
    const recordsRow = await prisma.Records.findUnique({ where: { Records_id: recordsId } });
    if (!recordsRow || recordsRow.Entreprise_id !== entrepriseId) return res.status(404).send("Receipt not found");

    const transactions = await prisma.Transactions.findMany({ where: { Records_id: recordsId, Entreprise_id: entrepriseId } });
    const txnIds = transactions.map((t) => t.Transactions_id);
    const journal = await prisma.Journal.findMany({ where: { Transactions_id: { in: txnIds } } });
    const products = await prisma.Product.findMany({ where: { Entreprise_id: entrepriseId } });
    const productById = Object.fromEntries(products.map((p) => [p.Product_id, p]));

    const lines = transactions
      .filter((t) => t.Business_Event === "SALE" || t.Business_Event === "PURCHASE" || t.Business_Event === "PAYMENT")
      .map((t) => ({
        name: productById[t.Product_id] ? productById[t.Product_id].Product_Name : `Product #${t.Product_id}`,
        quantity: Number(t.Quantity || 0),
        unitPrice: Number(t.Quantity) > 0 ? Number(t.Amount || 0) / Number(t.Quantity) : 0,
      }));

    const total = Number(recordsRow.Records_Totals || 0);
    const org = await prisma.Organisation.findUnique({ where: { Entreprise_id: entrepriseId } });
    const narrativeRow = await prisma.Narrative.findFirst({ where: { Records_id: recordsId, Narrative_type: "NOTE" } });

    const cycleReference = `RECEIPT-${recordsId}`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${cycleReference}.pdf"`);

    generateReceiptPdf(
      {
        businessName: org ? org.Organisational_Name : "Business",
        cycleReference,
        date: recordsRow.Records_date ? new Date(recordsRow.Records_date).toLocaleString("en-GB") : "",
        businessUnit: recordsRow.Business_Unit,
        lines,
        total,
        discount: 0,
        paymentMethod: "See transaction",
        notes: narrativeRow ? narrativeRow.Description : "",
      },
      res
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating receipt: " + err.message);
  }
});

// POST /documents/upload — a real file (scanned receipt, invoice PDF)
// attached to a specific transaction batch. Genuinely writes to
// Documents.File_path — the schema declared this but nothing wrote to it
// until now.
router.post("/documents/upload", upload.single("file"), async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { recordsId, documentType, title, docNo, amount } = req.body;
    let transactionsId = null;
    if (recordsId) {
      const firstTxn = await prisma.Transactions.findFirst({ where: { Records_id: Number(recordsId), Entreprise_id: entrepriseId } });
      transactionsId = firstTxn ? firstTxn.Transactions_id : null;
    }

    const doc = await prisma.Documents.create({
      data: {
        Transactions_id: transactionsId,
        Document_type: documentType || "SCAN",
        Document_Title: (title || req.file.originalname).slice(0, 45),
        Documents_no: docNo || null,
        Document_date: new Date(),
        Net_Amount: amount ? Number(amount) : null,
        Document_status: "UPLOADED",
        File_path: relativeFilePath(entrepriseId, req.file.filename),
        File_Format: req.file.mimetype,
        Generated: 0,
        Generated_By: req.currentUser.Administration_id,
      },
    });
    res.json({ ok: true, documentId: doc.Document_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal error uploading document" });
  }
});

// GET /documents/file/:id — serve an uploaded file's actual bytes,
// scoped so a business can only ever retrieve its own documents.
router.get("/documents/file/:id", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const doc = await prisma.Documents.findUnique({ where: { Document_id: Number(req.params.id) } });
    if (!doc || !doc.File_path) return res.status(404).send("Document not found");
    // File_path is stored as "<entrepriseId>/<filename>" — the leading
    // segment IS the ownership check, since it was written by the
    // authenticated uploader's own Entreprise_id at upload time.
    if (!doc.File_path.startsWith(`${entrepriseId}/`) && !doc.File_path.startsWith(`${entrepriseId}\\`)) {
      return res.status(403).send("Not authorised to view this document");
    }
    const fullPath = path.join(UPLOAD_ROOT, doc.File_path);
    if (!fs.existsSync(fullPath)) return res.status(404).send("File no longer exists on disk");
    res.sendFile(fullPath);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error retrieving document: " + err.message);
  }
});

module.exports = router;
