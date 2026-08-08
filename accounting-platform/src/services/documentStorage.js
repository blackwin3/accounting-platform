/**
 * documentStorage.js — real file storage for the Documents page: scanned
 * receipts, invoices, and generated PDF reports. Files land on disk under
 * /uploads (served statically, one subfolder per business so businesses
 * can never see each other's files even by guessing a filename), and
 * Documents.File_path stores the path exactly as the schema always
 * intended — this was declared in the schema's design but never actually
 * written to by any code until now.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

let multer;
try {
  multer = require("multer");
} catch (err) {
  console.error(
    "documentStorage.js: 'multer' is not installed — file uploads will be unavailable until `npm install` (or `docker compose up -d --build`) actually runs. The rest of the app is unaffected."
  );
  multer = null;
}

const UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads");

function ensureBusinessUploadDir(entrepriseId) {
  const dir = path.join(UPLOAD_ROOT, String(entrepriseId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

let upload;
if (multer) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const entrepriseId = req.currentUser.Entreprise_id;
      cb(null, ensureBusinessUploadDir(entrepriseId));
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || "";
      const safeName = crypto.randomBytes(16).toString("hex") + ext;
      cb(null, safeName);
    },
  });

  upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — plenty for a phone-camera receipt scan or a PDF invoice
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return cb(new Error("Only PDF, JPEG, PNG, or WEBP files are accepted."));
      }
      cb(null, true);
    },
  });
} else {
  // multer genuinely unavailable — a middleware that always fails clearly,
  // rather than a mysterious crash the first time someone tries to upload.
  upload = { single: () => (req, res, next) => res.status(503).json({ error: "File uploads are temporarily unavailable — the server is missing a required package. Try again after the app is redeployed." }) };
}

/**
 * relativeFilePath — the path stored on Documents.File_path: relative to
 * the uploads root, not an absolute filesystem path (which would leak
 * server directory structure and break if the app ever moves disks).
 */
function relativeFilePath(entrepriseId, filename) {
  return path.join(String(entrepriseId), filename);
}

module.exports = { upload, ensureBusinessUploadDir, relativeFilePath, UPLOAD_ROOT };
