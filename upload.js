const { handleUpload } = require("@vercel/blob/client");

function isAdmin(req) {
  const cookie = req.headers.cookie || "";
  return cookie.includes("luko_admin=");
}

module.exports = async (req, res) => {
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
    const body = req.body;

    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        return {
          allowedContentTypes: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/heic"
          ],
          maximumSizeInBytes: 10 * 1024 * 1024,
          addRandomSuffix: true
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log("Foto caricata:", blob.url);
      }
    });

    return res.status(200).json(jsonResponse);

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Impossibile caricare la foto"
    });
  }
};
