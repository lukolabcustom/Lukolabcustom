const { put } = require("@vercel/blob");
const crypto = require("crypto");

function createToken() {
  return crypto
    .createHmac(
      "sha256",
      process.env.ADMIN_PASSWORD
    )
    .update("luko-lab-admin-session")
    .digest("hex");
}

function isAdmin(req) {
  const cookie = req.headers.cookie || "";

  const match = cookie.match(
    /(?:^|;\s*)luko_admin=([^;]+)/
  );

  if (!match || !process.env.ADMIN_PASSWORD) {
    return false;
  }

  return match[1] === createToken();
}

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Non autorizzato"
    });
  }

  try {

    const {
      filename,
      contentType,
      data
    } = req.body || {};

    if (!filename || !data) {
      return res.status(400).json({
        error: "Foto mancante"
      });
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(contentType)) {
      return res.status(400).json({
        error: "Formato foto non supportato"
      });
    }

    const base64 =
      data.includes(",")
        ? data.split(",")[1]
        : data;

    const buffer =
      Buffer.from(base64, "base64");

    if (buffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({
        error: "La foto è troppo grande"
      });
    }

    const safeName =
      filename
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .toLowerCase();

    const pathname =
      "products/" +
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .substring(2, 8) +
      "-" +
      safeName;

    const blob =
      await put(
        pathname,
        buffer,
        {
          access: "public",
          contentType
        }
      );

    return res.status(200).json({
      ok: true,
      url: blob.url
    });

  } catch (error) {

    console.error(
      "UPLOAD ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Errore durante il caricamento della foto"
    });
  }
};
