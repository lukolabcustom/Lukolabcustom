const { put, list, del } = require("@vercel/blob");
const crypto = require("crypto");

const CATALOG_PATH = "catalog/products.json";

const defaultProducts = Array.from(
  { length: 14 },
  (_, index) => {
    const number = String(index + 1).padStart(2, "0");

    return {
      id: "cap-" + number,
      name: "Cappello Luko Lab " + number,
      price: 35,
      category: "Cappelli",
      image: null
    };
  }
);

function createToken() {
  return crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update("luko-lab-admin-session")
    .digest("hex");
}

function isAdmin(req) {
  try {
    const cookie = req.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)luko_admin=([^;]+)/);

    if (!match || !process.env.ADMIN_PASSWORD) {
      return false;
    }

    const received = decodeURIComponent(match[1]);
    const expected = createToken();

    if (received.length !== expected.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(received),
      Buffer.from(expected)
    );
  } catch (error) {
    return false;
  }
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

    if (req.method === "DELETE") {

      if (!isAdmin(req)) {
        return res.status(401).json({
          error: "Non autorizzato"
        });
      }

      const { id } = req.body || {};

      if (!id) {
        return res.status(400).json({
          error: "ID prodotto mancante"
        });
      }

      const products = await getCatalog();

      const product = products.find(
        item => item.id === id
      );

      if (!product) {
        return res.status(404).json({
          error: "Prodotto non trovato"
        });
      }

      const updatedProducts = products.filter(
        item => item.id !== id
      );

      await saveCatalog(updatedProducts);

      if (product.image) {
        try {
          await del(product.image);
        } catch (imageError) {
          console.error(
            "Impossibile eliminare la foto:",
            imageError
          );
        }
      }

      return res.status(200).json({
        ok: true
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
