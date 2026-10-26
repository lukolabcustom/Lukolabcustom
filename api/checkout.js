
const https = require("https");
const crypto = require("crypto");
const { list } = require("@vercel/blob");
const { neon } = require("@neondatabase/serverless");

const CURRENT_PREFIX = "catalog/current-";
const OLD_CATALOG = "catalog/products.json";

const shippingOptions = {
  north: { name: "Spedizione Nord Italia", amount: 500 },
  center: { name: "Spedizione Centro Italia", amount: 600 },
  south: { name: "Spedizione Sud Italia", amount: 700 },
  islands: { name: "Spedizione Sicilia e Sardegna", amount: 900 }
};

function getSql() {
  const url =
    process.env.neon_POSTGRES_URL ||
    process.env.neon_POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL;

  if (!url) throw new Error("Connessione Neon non configurata");

  return neon(url);
}

async function readBlob(blob) {
  const separator = blob.url.includes("?") ? "&" : "?";
  const response = await fetch(
    blob.url + separator + "cacheBust=" + Date.now()
  );

  if (!response.ok) throw new Error("Impossibile leggere il catalogo");

  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Catalogo non valido");

  return data;
}

async function getCatalog() {
  const current = await list({ prefix: CURRENT_PREFIX });

  if (current.blobs && current.blobs.length) {
    const blobs = [...current.blobs].sort((a, b) =>
      a.pathname.localeCompare(b.pathname)
    );
    return readBlob(blobs[blobs.length - 1]);
  }

  const old = await list({ prefix: OLD_CATALOG });
  const legacy = old.blobs &&
    old.blobs.find(blob => blob.pathname === OLD_CATALOG);

  if (legacy) return readBlob(legacy);

  throw new Error("Catalogo prodotti non disponibile");
}

function stripeRequest(data, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();

    const request = https.request({
      hostname: "api.stripe.com",
      path: "/v1/checkout/sessions",
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(process.env.STRIPE_SECRET_KEY + ":").toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Idempotency-Key": idempotencyKey
      }
    }, response => {
      let result = "";

      response.on("data", chunk => { result += chunk; });

      response.on("end", () => {
        let json;

        try {
          json = JSON.parse(result);
        } catch {
          return reject(new Error("Risposta non valida da Stripe"));
        }

        if (response.statusCode >= 400) {
          return reject(new Error(
            json.error?.message || "Errore Stripe"
          ));
        }

        resolve(json);
      });
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function reserveStock(sql, item) {
  if (!item.size) return;

  const rows = await sql`
    UPDATE product_stock
    SET quantity = quantity - ${item.quantity}
    WHERE product_id = ${item.id}
      AND size = ${item.size}
      AND quantity >= ${item.quantity}
    RETURNING product_id
  `;

  if (!rows.length) {
    throw new Error(
      `Disponibilità insufficiente per ${item.name}, taglia ${item.size}`
    );
  }
}

async function releaseStock(sql, reservations) {
  for (const item of [...reservations].reverse()) {
    if (!item.size) continue;

    await sql`
      UPDATE product_stock
      SET quantity = quantity + ${item.quantity}
      WHERE product_id = ${item.id}
        AND size = ${item.size}
    `;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({
      error: "Configurazione Stripe mancante"
    });
  }

  let sql;
  const reserved = [];
  let reservationId;

  try {
    const { items, shippingZone } = req.body || {};

    if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
      return res.status(400).json({ error: "Carrello non valido" });
    }

    const shipping = shippingOptions[shippingZone];
    if (!shipping) {
      return res.status(400).json({
        error: "Zona di spedizione non valida"
      });
    }

    const catalog = await getCatalog();
    sql = getSql();

    // Combina righe duplicate dello stesso prodotto e taglia.
    const quantities = new Map();

    for (const item of items) {
      const id = String(item.id || "");
      const size = item.size == null || item.size === "" ? null : item.size;
      const quantity = Number(item.quantity);

      if (
        !id ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10 ||
        (size !== null && !["S", "M"].includes(size))
      ) {
        return res.status(400).json({
          error: "Prodotto, taglia o quantità non validi"
        });
      }

      const key = id + "|" + (size || "");
      const previous = quantities.get(key);

      quantities.set(key, {
        id,
        size,
        quantity: quantity + (previous ? previous.quantity : 0)
      });
    }

    const validated = [];

    for (const requested of quantities.values()) {
      if (requested.quantity > 10) {
        return res.status(400).json({
          error: "Quantità massima per riga: 10"
        });
      }

      const product = catalog.find(p => p.id === requested.id);

      if (!product) {
        return res.status(400).json({
          error: "Un prodotto non è più disponibile"
        });
      }

      const isClothing = product.category === "Abbigliamento";

      if (isClothing && !requested.size) {
        return res.status(400).json({
          error: `Seleziona la taglia per ${product.name}`
        });
      }

      if (!isClothing && requested.size) {
        return res.status(400).json({
          error: `La taglia non è valida per ${product.name}`
        });
      }

      if (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0) {
        throw new Error("Prezzo catalogo non valido");
      }

      validated.push({
        id: product.id,
        name: String(product.name),
        price: Number(product.price),
        size: isClothing ? requested.size : null,
        quantity: requested.quantity
      });
    }

    // Ogni aggiornamento sottrae la quantità solo se è ancora disponibile.
    // In caso di errore, le prenotazioni già fatte vengono ripristinate.
    for (const item of validated) {
      if (item.size) {
        await reserveStock(sql, item);
        reserved.push(item);
      }
    }

    // Crea la tabella per collegare la prenotazione alla sessione Stripe.
    await sql`
      CREATE TABLE IF NOT EXISTS stock_reservations (
        reservation_id TEXT PRIMARY KEY,
        session_id TEXT,
        items JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    reservationId = crypto.randomUUID();

    await sql`
      INSERT INTO stock_reservations
        (reservation_id, items, status)
      VALUES
        (
          ${reservationId},
          ${JSON.stringify(reserved)},
          'pending'
        )
    `;

    const params = [];

    validated.forEach((item, index) => {
      const productName = item.size
        ? `${item.name} - Taglia ${item.size}`
        : item.name;

      params.push(
        [`line_items[${index}][price_data][currency]`, "eur"],
        [`line_items[${index}][price_data][product_data][name]`, productName],
        [`line_items[${index}][price_data][unit_amount]`,
          String(Math.round(item.price * 100))],
        [`line_items[${index}][quantity]`, String(item.quantity)]
      );
    });

    const shippingIndex = validated.length;

    params.push(
      [`line_items[${shippingIndex}][price_data][currency]`, "eur"],
      [`line_items[${shippingIndex}][price_data][product_data][name]`, shipping.name],
      [`line_items[${shippingIndex}][price_data][unit_amount]`, String(shipping.amount)],
      [`line_items[${shippingIndex}][quantity]`, "1"],
      ["mode", "payment"],
      ["payment_method_types[0]", "card"],
      ["shipping_address_collection[allowed_countries][0]", "IT"],
      ["phone_number_collection[enabled]", "true"],
      ["billing_address_collection", "auto"],
      ["customer_creation", "always"],
      ["metadata[shippingZone]", shippingZone],
      ["metadata[reservationId]", reservationId],
      ["success_url", "https://lukolabcustom.vercel.app/?success=1"],
      ["cancel_url", "https://lukolabcustom.vercel.app/?cancel=1"]
    );

    const session = await stripeRequest(params, reservationId);

    await sql`
      UPDATE stock_reservations
      SET session_id = ${session.id}
      WHERE reservation_id = ${reservationId}
    `;

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error("CHECKOUT ERROR:", error);

    if (sql && reserved.length) {
      try {
        await releaseStock(sql, reserved);

        if (reservationId) {
          await sql`
            UPDATE stock_reservations
            SET status = 'released'
            WHERE reservation_id = ${reservationId}
          `;
        }
      } catch (rollbackError) {
        console.error("ERRORE RIPRISTINO SCORTE:", rollbackError);
      }
    }

    const message = error.message || "";

    if (
      message.includes("Disponibilità insufficiente") ||
      message.includes("taglia") ||
      message.includes("non è più disponibile")
    ) {
      return res.status(409).json({ error: message });
    }

    return res.status(500).json({
      error: "Impossibile creare il pagamento. Riprova tra poco."
    });
  }
};
