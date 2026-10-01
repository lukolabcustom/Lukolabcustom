const { put, list, del } = require("@vercel/blob");
const crypto = require("crypto");

const CURRENT_PREFIX = "catalog/current-";
const OLD_CATALOG = "catalog/products.json";

/* =========================
   PRODOTTI INIZIALI
========================= */

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

/* =========================
   AUTENTICAZIONE ADMIN
========================= */

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

/* =========================
   LEGGI UN BLOB JSON
========================= */

async function readBlob(blob) {
  const separator = blob.url.includes("?")
    ? "&"
    : "?";

  const response = await fetch(
    blob.url +
      separator +
      "cacheBust=" +
      Date.now()
  );

  if (!response.ok) {
    throw new Error(
      "Impossibile leggere il catalogo"
    );
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error(
      "Catalogo non valido"
    );
  }

  return data;
}

/* =========================
   LEGGI CATALOGO
========================= */

async function getCatalog() {
  try {
    /*
      Prima cerchiamo il nuovo sistema
      current-XXXXXXXX.json
    */

    const current = await list({
      prefix: CURRENT_PREFIX
    });

    if (
      current.blobs &&
      current.blobs.length > 0
    ) {
      /*
        I nomi contengono un timestamp,
        quindi l'ultimo nome è l'ultimo catalogo.
      */

      const blobs = [...current.blobs].sort(
        (a, b) =>
          a.pathname.localeCompare(
            b.pathname
          )
      );

      const latest =
        blobs[blobs.length - 1];

      return await readBlob(latest);
    }

    /*
      MIGRAZIONE DEL VECCHIO CATALOGO
    */

    const old = await list({
      prefix: OLD_CATALOG
    });

    const exactOld =
      old.blobs &&
      old.blobs.find(
        blob =>
          blob.pathname === OLD_CATALOG
      );

    if (exactOld) {
      return await readBlob(exactOld);
    }

    /*
      Se non troviamo nulla,
      partiamo dai 14 prodotti iniziali.
    */

    return defaultProducts;

  } catch (error) {
    console.error(
      "GET CATALOG ERROR:",
      error
    );

    return defaultProducts;
  }
}

/* =========================
   SALVA NUOVO CATALOGO
========================= */

async function saveCatalog(products) {
  const timestamp =
    Date.now().toString().padStart(15, "0");

  const random =
    crypto
      .randomBytes(4)
      .toString("hex");

  const pathname =
    CURRENT_PREFIX +
    timestamp +
    "-" +
    random +
    ".json";

  await put(
    pathname,
    JSON.stringify(products),
    {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json"
    }
  );

  return pathname;
}

/* =========================
   API
========================= */

module.exports = async function handler(
  req,
  res
) {
  try {
    /* =====================
       GET
    ===================== */

    if (req.method === "GET") {
      const products =
        await getCatalog();

      return res.status(200).json({
        products
      });
    }

    /* =====================
       POST
       AGGIUNGI PRODOTTO
    ===================== */

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
          error:
            "Nome e foto sono obbligatori"
        });
      }

      const numericPrice =
        Number(price);

      if (
        !Number.isFinite(
          numericPrice
        ) ||
        numericPrice <= 0
      ) {
        return res.status(400).json({
          error:
            "Prezzo non valido"
        });
      }

      if (
        category !== "Cappelli" &&
        category !== "Abbigliamento"
      ) {
        return res.status(400).json({
          error:
            "Categoria non valida"
        });
      }

      const products =
        await getCatalog();

      const product = {
        id:
          "product-" +
          Date.now() +
          "-" +
          crypto
            .randomBytes(4)
            .toString("hex"),

        name:
          String(name).trim(),

        price:
          Math.round(
            numericPrice * 100
          ) / 100,

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

    /* =====================
       DELETE
       ELIMINA PRODOTTO
    ===================== */

    if (req.method === "DELETE") {
      if (!isAdmin(req)) {
        return res.status(401).json({
          error: "Non autorizzato"
        });
      }

      const { id } =
        req.body || {};

      if (!id) {
        return res.status(400).json({
          error:
            "ID prodotto mancante"
        });
      }

      const products =
        await getCatalog();

      const product =
        products.find(
          item => item.id === id
        );

      if (!product) {
        return res.status(404).json({
          error:
            "Prodotto non trovato"
        });
      }

      const updatedProducts =
        products.filter(
          item => item.id !== id
        );

      /*
        SALVIAMO PRIMA IL NUOVO CATALOGO.
        Il vecchio catalogo rimane intatto.
      */

      await saveCatalog(
        updatedProducts
      );

      /*
        POI proviamo a eliminare
        anche la vecchia immagine.
        Se la foto non si elimina,
        il prodotto rimane comunque
        eliminato dal catalogo.
      */

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
        message:
          "Prodotto eliminato"
      });
    }

    /* =====================
       METODO NON CONSENTITO
    ===================== */

    return res.status(405).json({
      error:
        "Metodo non consentito"
    });

  } catch (error) {
    console.error(
      "CATALOG ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Errore durante la gestione del catalogo"
    });
  }
};
