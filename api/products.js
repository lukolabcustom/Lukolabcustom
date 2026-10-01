const { put, list, del } = require("@vercel/blob");
const crypto = require("crypto");

const CATALOG_PREFIX = "catalog/current-";

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
    .update("luko-lab-admin-session")
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

  return match[1] === createToken();
}


/* =========================
   LEGGI ULTIMO CATALOGO
========================= */

async function getCatalog() {

  try {

    /*
      Cerchiamo solo le versioni
      nuove del catalogo.
    */

    const result =
      await list({
        prefix: CATALOG_PREFIX,
        limit: 100
      });


    if (
      !result.blobs ||
      result.blobs.length === 0
    ) {

      /*
        Compatibilità con il vecchio
        catalogo eventualmente esistente.
      */

      const oldResult =
        await list({
          prefix: "catalog/products",
          limit: 100
        });


      if (
        !oldResult.blobs ||
        oldResult.blobs.length === 0
      ) {
        return defaultProducts;
      }


      const oldBlob =
        oldResult.blobs
          .sort(function(a, b) {

            return a.pathname.localeCompare(
              b.pathname
            );

          })
          .at(-1);


      const oldResponse =
        await fetch(
          oldBlob.url +
          (oldBlob.url.includes("?")
            ? "&cache=0"
            : "?cache=0")
        );


      const oldData =
        await oldResponse.json();


      return Array.isArray(oldData)
        ? oldData
        : defaultProducts;
    }


    /*
      I nomi sono:

      current-0000000000000-xxxxx.json

      quindi possiamo ordinare
      direttamente per pathname.
    */

    const sorted =
      result.blobs.sort(
        function(a, b) {

          return a.pathname.localeCompare(
            b.pathname
          );

        }
      );


    const latest =
      sorted[sorted.length - 1];


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
   SALVA CATALOGO
========================= */

async function saveCatalog(products) {

  const timestamp =
    Date.now()
      .toString()
      .padStart(15, "0");


  const random =
    crypto
      .randomBytes(6)
      .toString("hex");


  const pathname =
    CATALOG_PREFIX +
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
}


/* =========================
   API
========================= */

module.exports =
  async function handler(req, res) {

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


        products.push(product);


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


        const updatedProducts =
          products.filter(
            function(item) {
              return item.id !== id;
            }
          );


        /*
          Salviamo una NUOVA versione
          del catalogo.
        */

        await saveCatalog(
          updatedProducts
        );


        /*
          La foto può essere eliminata
          senza influire sul catalogo.
        */

        if (product.image) {

          try {

            await del(
              product.image
            );

          } catch (imageError) {

            console.error(
              "Errore eliminazione foto:",
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
