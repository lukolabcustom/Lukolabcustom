const { put, list, del } = require("@vercel/blob");
const crypto = require("crypto");

const CATALOG_PREFIX = "catalog/";

/*
  Catalogo iniziale.
  Verrà usato solo se non esiste ancora
  nessun catalogo salvato.
*/

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
   TOKEN ADMIN
========================= */

function createToken() {

  return crypto
    .createHmac(
      "sha256",
      process.env.ADMIN_PASSWORD
    )
    .update(
      "luko-lab-admin-session"
    )
    .digest("hex");
}


function isAdmin(req) {

  const cookie =
    req.headers.cookie || "";

  const match =
    cookie.match(
      /(?:^|;\s*)luko_admin=([^;]+)/
    );

  if (
    !match ||
    !process.env.ADMIN_PASSWORD
  ) {
    return false;
  }

  return (
    match[1] === createToken()
  );
}


/* =========================
   TROVA ULTIMO CATALOGO
========================= */

async function findLatestCatalog() {

  const result =
    await list({
      prefix: CATALOG_PREFIX,
      limit: 100
    });

  if (
    !result.blobs ||
    result.blobs.length === 0
  ) {
    return null;
  }

  /*
    Prendiamo il catalogo più recente
    in base alla data di caricamento.
  */

  const sorted =
    [...result.blobs].sort(
      function(a, b) {

        return (
          new Date(b.uploadedAt).getTime() -
          new Date(a.uploadedAt).getTime()
        );

      }
    );

  return sorted[0];
}


/* =========================
   LEGGI CATALOGO
========================= */

async function getCatalog() {

  try {

    const latest =
      await findLatestCatalog();


    if (!latest) {

      return defaultProducts;
    }


    /*
      cache=0 evita di leggere
      una versione precedente.
    */

    const separator =
      latest.url.includes("?")
        ? "&"
        : "?";


    const response =
      await fetch(
        latest.url +
        separator +
        "cache=0"
      );


    if (!response.ok) {

      throw new Error(
        "Impossibile leggere il catalogo"
      );
    }


    const data =
      await response.json();


    if (
      !Array.isArray(data)
    ) {

      return defaultProducts;
    }


    return data;


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

async function saveCatalog(
  products
) {

  /*
    Creiamo sempre un nuovo file.

    Questo evita problemi di cache
    e di sovrascrittura del Blob.
  */

  const pathname =
    CATALOG_PREFIX +
    "products-" +
    Date.now() +
    "-" +
    crypto
      .randomBytes(6)
      .toString("hex") +
    ".json";


  const blob =
    await put(
      pathname,
      JSON.stringify(products),
      {
        access: "public",
        addRandomSuffix: false,
        contentType:
          "application/json",
        cacheControlMaxAge: 60
      }
    );


  return blob;
}


/* =========================
   API
========================= */

module.exports =
  async function handler(
    req,
    res
  ) {

    try {


      /* =====================
         GET
      ===================== */

      if (
        req.method === "GET"
      ) {

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

      if (
        req.method === "POST"
      ) {

        if (!isAdmin(req)) {

          return res.status(401).json({
            error:
              "Non autorizzato"
          });
        }


        const {
          name,
          price,
          category,
          image
        } = req.body || {};


        if (
          !name ||
          !image
        ) {

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


        products.push(
          product
        );


        await saveCatalog(
          products
        );


        return res.status(200).json({

          ok: true,

          product

        });
      }


      /* =====================
         DELETE
         ELIMINA PRODOTTO
      ===================== */

      if (
        req.method === "DELETE"
      ) {

        if (!isAdmin(req)) {

          return res.status(401).json({
            error:
              "Non autorizzato"
          });
        }


        const {
          id
        } = req.body || {};


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
            function(item) {

              return item.id === id;

            }
          );


        if (!product) {

          return res.status(404).json({
            error:
              "Prodotto non trovato"
          });
        }


        /*
          Creiamo il nuovo catalogo
          SENZA il prodotto eliminato.
        */

        const updatedProducts =
          products.filter(
            function(item) {

              return item.id !== id;

            }
          );


        /*
          Salviamo una nuova versione
          del catalogo.
        */

        await saveCatalog(
          updatedProducts
        );


        /*
          Eliminiamo la foto del prodotto.
          Se la foto non può essere eliminata,
          il prodotto rimane comunque eliminato
          dal catalogo.
        */

        if (
          product.image
        ) {

          try {

            await del(
              product.image
            );

          } catch (imageError) {

            console.error(
              "ERRORE FOTO:",
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
