const { put, list } = require("@vercel/blob");
const crypto = require("crypto");

const CATALOG_PATH = "catalog/products.json";

const defaultProducts = [];

function isAdmin(req) {
  const cookie = req.headers.cookie || "";
  return cookie.includes("luko_admin=");
}

async function getCatalog() {
  try {
    const result = await list({
      prefix: CATALOG_PATH,
      limit: 1
    });

    if (!result.blobs || result.blobs.length === 0) {
      return defaultProducts;
    }

    const response = await fetch(result.blobs[0].url);
    const data = await response.json();

    if (!Array.isArray(data)) {
      return defaultProducts;
    }

    return data;

  } catch (error) {
    console.error(error);
    return defaultProducts;
  }
}

async function saveCatalog(products) {
  await put(
    CATALOG_PATH,
    JSON.stringify(products),
    {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json"
    }
  );
}

module.exports = async (req, res) => {

  try {

    if (req.method === "GET") {

      const products = await getCatalog();

      return res.status(200).json({
        products
      });
    }


    if (req.method === "POST") {

      if (!isAdmin(req)) {
        return res.status(401).json({
          error: "Non autorizzato"
        });
      }

      const {
        name,
        price,
        category,
        image
      } = req.body || {};


      if (!name || !image) {
        return res.status(400).json({
          error: "Nome e foto sono obbligatori"
        });
      }


      const numericPrice = Number(price);

      if (
        !Number.isFinite(numericPrice) ||
        numericPrice <= 0
      ) {
        return res.status(400).json({
          error: "Prezzo non valido"
        });
      }


      if (
        category !== "Cappelli" &&
        category !== "Abbigliamento"
      ) {
        return res.status(400).json({
          error: "Categoria non valida"
        });
      }


      const products = await getCatalog();


      const product = {
        id:
          "product-" +
          Date.now() +
          "-" +
          crypto.randomBytes(4).toString("hex"),

        name: String(name).trim(),

        price:
          Math.round(numericPrice * 100) / 100,

        category,

        image,

        createdAt:
          new Date().toISOString()
      };


      products.push(product);

      await saveCatalog(products);


      return res.status(200).json({
        ok: true,
        product
      });
    }


    return res.status(405).json({
      error: "Metodo non consentito"
    });


  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Errore durante la gestione del catalogo"
    });
  }
};
