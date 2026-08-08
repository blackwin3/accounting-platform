/**
 * receiptPdf.js — real PDF generation for a Till receipt, using pdfkit
 * (a genuine PDF library, not an HTML-to-PDF hack). Builds directly from
 * the actual Records/Transactions/Journal rows for one basket, so the
 * receipt always reflects what was really posted — never a separately
 * maintained copy that could drift from the ledger.
 */

let PDFDocument;
try {
  PDFDocument = require("pdfkit");
} catch (err) {
  console.error(
    "receiptPdf.js: 'pdfkit' is not installed — PDF receipt generation will be unavailable until `npm install` (or `docker compose up -d --build`) actually runs. The rest of the app is unaffected."
  );
  PDFDocument = null;
}

/**
 * generateReceiptPdf — streams a one-page PDF receipt for a single
 * Records batch (one Till basket) directly to the given writable stream
 * (typically an HTTP response, or a file write stream).
 */
function generateReceiptPdf({ businessName, cycleReference, date, businessUnit, lines, total, discount, paymentMethod, notes }, outputStream) {
  if (!PDFDocument) {
    throw new Error("PDF generation is temporarily unavailable — the server is missing a required package. Try again after the app is redeployed.");
  }
  const doc = new PDFDocument({ size: "A5", margin: 36 });
  doc.pipe(outputStream);

  doc.fontSize(16).font("Helvetica-Bold").text(businessName || "Receipt", { align: "center" });
  doc.fontSize(9).font("Helvetica").fillColor("#666").text(businessUnit || "", { align: "center" });
  doc.moveDown(0.5);
  const headerY = doc.y;
  doc.fontSize(9).fillColor("#000").text(`Receipt: ${cycleReference}`, doc.page.margins.left, headerY);
  doc.text(`Date: ${date}`, doc.page.margins.left, headerY, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "right" });
  doc.moveDown(0.5);
  doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#ccc").stroke();
  doc.moveDown(0.5);

  // Real fixed-width columns via explicit x-coordinates — pdfkit's
  // `continued: true` only chains text immediately after wherever the
  // cursor currently sits; it does NOT create genuine fixed-width
  // columns despite accepting a `width` option, which is exactly what
  // was compressing Item/Qty/Price/Amount into one unreadable run.
  // Widths verified to genuinely fit A5's usable width (page width 420pt
  // minus 36pt margins on each side = ~348pt usable) — the first version
  // of this fix used widths that summed past the page edge.
  const tableLeft = doc.page.margins.left;
  const colWidths = { item: 165, qty: 45, price: 60, amount: 70 };
  const colItem = tableLeft;
  const colQty = colItem + colWidths.item;
  const colPrice = colQty + colWidths.qty;
  const colAmount = colPrice + colWidths.price;

  doc.font("Helvetica-Bold").fontSize(9);
  let rowY = doc.y;
  doc.text("Item", colItem, rowY, { width: colWidths.item });
  doc.text("Qty", colQty, rowY, { width: colWidths.qty, align: "right" });
  doc.text("Price", colPrice, rowY, { width: colWidths.price, align: "right" });
  doc.text("Amount", colAmount, rowY, { width: colWidths.amount, align: "right" });
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(9);

  for (const line of lines) {
    rowY = doc.y;
    doc.text(line.name, colItem, rowY, { width: colWidths.item });
    doc.text(String(line.quantity), colQty, rowY, { width: colWidths.qty, align: "right" });
    doc.text(line.unitPrice.toFixed(2), colPrice, rowY, { width: colWidths.price, align: "right" });
    doc.text((line.quantity * line.unitPrice).toFixed(2), colAmount, rowY, { width: colWidths.amount, align: "right" });
    doc.moveDown(0.4);
  }

  doc.moveDown(0.5);
  doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#ccc").stroke();
  doc.moveDown(0.3);

  const listTotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  doc.font("Helvetica").fontSize(9).text(`List Total: KES ${listTotal.toFixed(2)}`, { align: "right" });
  if (discount) {
    doc.text(`Discount: KES ${Math.abs(discount).toFixed(2)}`, { align: "right" });
  }
  doc.font("Helvetica-Bold").fontSize(11).text(`Total Paid: KES ${total.toFixed(2)}`, { align: "right" });
  doc.font("Helvetica").fontSize(9).text(`Payment Method: ${paymentMethod}`, { align: "right" });

  if (notes) {
    doc.moveDown(0.5);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#666").text(`Note: ${notes}`);
  }

  doc.moveDown(1);
  doc.fontSize(7).fillColor("#999").text("Generated directly from the posted transaction record.", { align: "center" });

  doc.end();
}

module.exports = { generateReceiptPdf };
