


const crypto = require("crypto");

function createToken(password) {
  return crypto
    .createHmac("sha256", password)
    .update("luko-lab-admin-session")
    .digest("hex");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  try {
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      console.error("Variabile ADMIN_PASSWORD non configurata");
      return res.status(500).json({
        error: "Accesso amministratore non configurato su Vercel"
      });
    }

    const body = req.body || {};
    const password = body.password;

    if (
      typeof password !== "string" ||
      password.length === 0
    ) {
      return res.status(400).json({
        error: "Inserisci la password amministratore"
      });
    }

    const supplied = Buffer.from(password);
    const expected = Buffer.from(adminPassword);

    const valid =
      supplied.length === expected.length &&
      crypto.timingSafeEqual(supplied, expected);

    if (!valid) {
      return res.status(401).json({
        error: "Password non corretta"
      });
    }

    const token = createToken(adminPassword);

    res.setHeader("Set-Cookie", [
      "luko_admin=" + token +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400"
    ]);

    return res.status(200).json({
      ok: true
    });
  } catch (error) {
    console.error("ADMIN LOGIN ERROR:", error);

    return res.status(500).json({
      error: "Errore durante l'accesso amministratore"
    });
  }
};
