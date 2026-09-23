const crypto = require("crypto");

function createToken() {
  return crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update("luko-lab-admin-session")
    .digest("hex");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  try {
    const { password } = req.body || {};

    if (!process.env.ADMIN_PASSWORD) {
      return res.status(500).json({ error: "Password admin non configurata" });
    }

    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password non corretta" });
    }

    const token = createToken();

    res.setHeader(
      "Set-Cookie",
      `luko_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Errore del server" });
  }
};
