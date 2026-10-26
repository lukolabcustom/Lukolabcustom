
const { put, list, del } = require("@vercel/blob");
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const CURRENT_PREFIX = "catalog/current-";
const OLD_CATALOG = "catalog/products.json";

const defaultProducts = Array.from({ length: 14 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    id: "cap-" + number,
    name: "Cappello Luko Lab " + number,
    price: 35,
    category: "Cappelli",
    image: null
  };
});

function getSql() {
  const url =
    process.env.neon_POSTGRES_URL ||
    process.env.neon_POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL;

  if (!url) {
    throw new Error("Connessione Neon non configurata su Vercel");
  }

  return neon(url);
}

function createToken() {
  return crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update("luko-lab-admin-session")
    .digest("hex");
}

function isAdmin(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)luko_admin=([^;]+)/);

  if (!match || !process.env.ADMIN_PASSWORD) return false;

  return match[1] === createToken();
}

async function readBlob(blob) {
  const separator = blob.url.includes("?") ? "&" : "?";
  const response = await fetch(
    blob.url + separator + "cacheBust=" + Date.now()
  );

  if (!response.ok) {
    throw new Error("Impossibile leggere il catalogo");
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Catalogo non valido");
  }

  return data;
}

async function getCatalog() {
  const current = await list({ prefix: CURRENT_PREFIX });

  if (current.blobs && current.blobs.length > 0) {
    const blobs = [...current.blobs].sort((a, b) =>
      a.pathname.localeCompare(b.pathname)
    );

    return readBlob(blobs[blobs.length - 1]);
  }

  const old = await list({ prefix: OLD_CATALOG });
  const exactOld =
    old.blobs &&
    old.blobs.find(blob => blob.pathname === OLD_CATALOG);

  if (exactOld) return readBlob(exactOld);

  return defaultProducts;
}

async function saveCatalog(products) {
  const timestamp = Date.now().toString().padStart(15, "0");
  const random = crypto.randomBytes(4).toString("hex");
  const pathname =
    CURRENT_PREFIX + timestamp + "-" + random + ".json";

  await put(pathname, JSON.stringify(products), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json"
  });

  return pathname;
}

function validStock(stock) {
  if (!stock || typeof stock !== "object") return false;

  return ["S", "M"].every(size => {
    const quantity = stock[size];

    return (
      Number.isInteger(quantity) &&
      quantity >= 0 &&
      quantity <= 100000
    );
  });
}

async function getStockMap() {
  const sql = getSql();
  const rows = await sql`
    SELECT product_id, size, quantity
    FROM product_stock
  `;

  const result = {};

  for (const row of rows) {
    if (!result[row.product_id]) {
      result[row.product_id] = { S: 0, M: 0 };
    }

    result[row.product_id][row.size] = Number(row.quantity);
  }

  return result;
}

async function saveStock(sql, productId, stock) {
  await sql`
    INSERT INTO product_stock (product_id, size, quantity)
    VALUES
      (${productId}, 'S', ${stock.S}),
      (${productId}, 'M', ${stock.M})
    ON CONFLICT (product_id, size)
    DO UPDATE SET quantity = EXCLUDED.quantity
  `;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const products = await getCatalog();
      const stockMap = await getStockMap();

      const enrichedProducts = products.map(product => ({
        ...product,
        stock: stockMap[product.id] || { S: 0, M: 0 }
      }));

      res.setHeader("Cache-Control", "no-store");

      return res.status(200).json({
        products: enrichedProducts
      });
    }

    if (!isAdmin(req)) {
      return res.status(401).json({
        error: "Non autorizzato"
      });
    }

    if (req.method === "POST") {
      const { name, price, category, image, stock } = req.body || {};

      if (!name || !image) {
        return res.status(400).json({
          error: "Nome e foto sono obbligatori"
        });
      }

      const numericPrice = Number(price);

      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
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

      if (!validStock(stock)) {
        return res.status(400).json({
          error: "Inserisci quantità intere valide per S e M"
        });
      }

      const products = await getCatalog();
      const sql = getSql();

      const product = {
        id:
          "product-" +
          Date.now() +
          "-" +
          crypto.randomBytes(4).toString("hex"),
        name: String(name).trim(),
        price: Math.round(numericPrice * 100) / 100,
        category,
        image,
        createdAt: new Date().toISOString()
      };

      // Salva le scorte in Neon prima di pubblicare il prodotto.
      await saveStock(sql, product.id, stock);

      try {
        products.push(product);
        await saveCatalog(products);
      } catch (error) {
        await sql`
          DELETE FROM product_stock
          WHERE product_id = ${product.id}
        `;
        throw error;
      }

      return res.status(200).json({
        ok: true,
        product: {
          ...product,
          stock
        }
      });
    }

    if (req.method === "DELETE") {
      const { id } = req.body || {};

      if (!id) {
        return res.status(400).json({
          error: "ID prodotto mancante"
        });
      }

      const products = await getCatalog();
      const product = products.find(item => item.id === id);

      if (!product) {
        return res.status(404).json({
          error: "Prodotto non trovato"
        });
      }

      const updatedProducts = products.filter(
        item => item.id !== id
      );

      await saveCatalog(updatedProducts);

      const sql = getSql();

      await sql`
        DELETE FROM product_stock
        WHERE product_id = ${id}
      `;

      if (product.image) {
        try {
          await del(product.image);
        } catch (imageError) {
          console.error(
            "ERRORE ELIMINAZIONE FOTO:",
            imageError
          );
        }
      }

      return res.status(200).json({
        ok: true,
        message: "Prodotto eliminato"
      });
    }

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  } catch (error) {
    console.error("CATALOG ERROR:", error);

    return res.status(500).json({
      error: "Errore durante la gestione del catalogo"
    });
  }
};
