

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
    image: null,
    images: []
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

/* VALIDAZIONE SCORTE */
function validQuantity(quantity) {
  return (
    Number.isInteger(quantity) &&
    quantity >= 0 &&
    quantity <= 100000
  );
}

function validStock(category, stock) {
  if (!stock || typeof stock !== "object" || Array.isArray(stock)) {
    return false;
  }

  if (category === "Cappelli") {
    return validQuantity(stock.ONE);
  }

  if (category === "Abbigliamento") {
    return (
      validQuantity(stock.S) &&
      validQuantity(stock.M)
    );
  }

  return false;
}

/* LEGGE LE SCORTE DA NEON */
async function getStockMap() {
  const sql = getSql();

  const rows = await sql`
    SELECT product_id, size, quantity
    FROM product_stock
  `;

  const result = {};

  for (const row of rows) {
    if (!result[row.product_id]) {
      result[row.product_id] = {};
    }

    result[row.product_id][row.size] = Number(row.quantity);
  }

  return result;
}

/* SALVA LE SCORTE */
async function saveStock(sql, productId, category, stock) {
  if (category === "Cappelli") {
    await sql`
      INSERT INTO product_stock (product_id, size, quantity)
      VALUES (${productId}, 'ONE', ${stock.ONE})
      ON CONFLICT (product_id, size)
      DO UPDATE SET quantity = EXCLUDED.quantity
    `;

    return;
  }

  await sql`
    INSERT INTO product_stock (product_id, size, quantity)
    VALUES
      (${productId}, 'S', ${stock.S}),
      (${productId}, 'M', ${stock.M})
    ON CONFLICT (product_id, size)
    DO UPDATE SET quantity = EXCLUDED.quantity
  `;
}

/* NORMALIZZA LE FOTO DEI PRODOTTI */
function getProductImages(product) {
  const images = Array.isArray(product.images)
    ? product.images.filter(url => typeof url === "string" && url.trim())
    : [];

  if (images.length > 0) {
    return [...new Set(images)];
  }

  return product.image ? [product.image] : [];
}

/* GESTIONE API */
module.exports = async function handler(req, res) {
  try {

    /* GET: ELENCO PRODOTTI */
    if (req.method === "GET") {
      const products = await getCatalog();
      const stockMap = await getStockMap();

      const enrichedProducts = products.map(product => {
        const storedStock = stockMap[product.id] || {};
        const images = getProductImages(product);

        const stock = product.category === "Abbigliamento"
          ? {
              S: Number(storedStock.S || 0),
              M: Number(storedStock.M || 0)
            }
          : {
              ONE: Number(storedStock.ONE || 0)
            };

        return {
          ...product,
          image: images[0] || null,
          images,
          stock
        };
      });

      res.setHeader("Cache-Control", "no-store");

      return res.status(200).json({
        products: enrichedProducts
      });
    }

    /* AUTORIZZAZIONE */
    if (!isAdmin(req)) {
      return res.status(401).json({
        error: "Non autorizzato"
      });
    }

    /* POST: AGGIUNGI PRODOTTO */
    if (req.method === "POST") {
      const {
        name,
        price,
        category,
        image,
        images,
        stock
      } = req.body || {};

      const cleanImages = Array.isArray(images)
        ? [...new Set(
            images.filter(
              url => typeof url === "string" && url.trim()
            )
          )]
        : [];

      const finalImages = cleanImages.length
        ? cleanImages
        : (typeof image === "string" && image.trim() ? [image] : []);

      if (!name || typeof name !== "string" || !name.trim() || finalImages.length === 0) {
        return res.status(400).json({
          error: "Nome e almeno una foto sono obbligatori"
        });
      }

      if (finalImages.length > 10) {
        return res.status(400).json({
          error: "Puoi inserire al massimo 10 fotografie"
        });
      }

      if (!finalImages.every(url => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === "https:";
        } catch {
          return false;
        }
      })) {
        return res.status(400).json({
          error: "Indirizzo di una fotografia non valido"
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

      if (!validStock(category, stock)) {
        return res.status(400).json({
          error: category === "Cappelli"
            ? "Inserisci una quantità intera valida per il cappello"
            : "Inserisci quantità intere valide per S e M"
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
        name: name.trim(),
        price: Math.round(numericPrice * 100) / 100,
        category,
        image: finalImages[0],
        images: finalImages,
        createdAt: new Date().toISOString()
      };

      /* SALVA LE SCORTE PRIMA DI PUBBLICARE */
      await saveStock(sql, product.id, category, stock);

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

    /* DELETE: ELIMINA PRODOTTO */
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

      /* ELIMINA TUTTE LE FOTO */
      const images = getProductImages(product);

      for (const imageUrl of images) {
        try {
          await del(imageUrl);
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
