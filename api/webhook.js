


const Stripe = require("stripe");
const { neon } = require("@neondatabase/serverless");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const RESEND_API_URL = "https://api.resend.com/emails";

function getSql() {
  const url =
    process.env.neon_POSTGRES_URL ||
    process.env.neon_POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL;

  if (!url) {
    throw new Error("Connessione Neon non configurata");
  }

  return neon(url);
}

// Legge il corpo originale della richiesta Stripe.
async function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendEmail(order) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY non configurata");
  }

  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding:8px 0">
        ${escapeHtml(item.name)}
      </td>
      <td style="padding:8px 0;text-align:center">
        ${item.quantity}
      </td>
      <td style="padding:8px 0;text-align:right">
        €${(item.amount / 100).toFixed(2)}
      </td>
    </tr>
  `).join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto">
      <h1>🌴 Nuovo ordine Luko Lab Custom</h1>
      <p>Pagamento completato.</p>
      <hr>

      <h2>🛍️ Prodotti</h2>

      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left">Prodotto</th>
            <th>Qtà</th>
            <th style="text-align:right">Prezzo</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>

      <hr>

      <h2>👤 Cliente</h2>
      <p><strong>Nome:</strong> ${escapeHtml(order.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(order.email)}</p>
      <p><strong>Telefono:</strong> ${escapeHtml(order.phone)}</p>

      <h2>📍 Spedizione</h2>
      <p>${escapeHtml(order.address)}</p>
      <p><strong>Zona:</strong> ${escapeHtml(order.shippingZone)}</p>

      <h2>💰 Totale ordine</h2>
      <p style="font-size:24px;font-weight:bold">
        €${(order.total / 100).toFixed(2)}
      </p>

      <hr>
      <p>ID ordine Stripe: ${escapeHtml(order.sessionId)}</p>
    </div>
  `;

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Luko Lab Custom <onboarding@resend.dev>",
      to: ["Lukolabcustom@gmail.com"],
      subject: "🌴 Nuovo ordine Luko Lab Custom",
      html
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || "Errore invio email Resend"
    );
  }

  return data;
}

// Ripristina le scorte una sola volta.
async function releaseReservation(sql, sessionId) {
  const rows = await sql`
    UPDATE stock_reservations
    SET status = 'released'
    WHERE session_id = ${sessionId}
      AND status = 'pending'
    RETURNING items
  `;

  if (!rows.length) return;

  const items = Array.isArray(rows[0].items)
    ? rows[0].items
    : JSON.parse(rows[0].items || "[]");

  for (const item of items) {
    if (!item.size) continue;

    await sql`
      UPDATE product_stock
      SET quantity = quantity + ${Number(item.quantity)}
      WHERE product_id = ${item.id}
        AND size = ${item.size}
    `;
  }

  console.log("SCORTE RIPRISTINATE:", sessionId);
}

// Conferma la prenotazione una sola volta.
async function confirmReservation(sql, sessionId) {
  const rows = await sql`
    UPDATE stock_reservations
    SET status = 'confirmed'
    WHERE session_id = ${sessionId}
      AND status = 'pending'
    RETURNING reservation_id
  `;

  return rows.length > 0;
}

async function buildOrder(session) {
  const lineItems = await stripe.checkout.sessions.listLineItems(
    session.id,
    { limit: 100 }
  );

  const items = lineItems.data
    .filter(item =>
      !String(item.description || "").startsWith("Spedizione ")
    )
    .map(item => ({
      name: item.description || "Prodotto",
      quantity: item.quantity || 1,
      amount: item.amount_total || 0
    }));

  const customer = session.customer_details || {};
  const address = customer.address || {};

  const addressText = [
    address.line1,
    address.line2,
    address.postal_code,
    address.city,
    address.state,
    address.country
  ].filter(Boolean).join(", ");

  return {
    sessionId: session.id,
    name: customer.name || "Non specificato",
    email: customer.email || "Non specificata",
    phone: customer.phone || "Non specificato",
    address: addressText || "Non specificato",
    shippingZone: session.metadata?.shippingZone || "Non specificata",
    total: session.amount_total || 0,
    items
  };
}

async function processCompletedSession(sql, session) {
  if (session.payment_status !== "paid") {
    console.log(
      "Pagamento non ancora completato:",
      session.id
    );

    return;
  }

  const reservationId = session.metadata?.reservationId;

  if (!reservationId) {
    throw new Error(
      "Prenotazione inventario mancante: " + session.id
    );
  }

  // Collega la sessione alla prenotazione.
  await sql`
    UPDATE stock_reservations
    SET session_id = ${session.id}
    WHERE reservation_id = ${reservationId}
      AND (session_id IS NULL OR session_id = ${session.id})
  `;

  const reservation = await sql`
    SELECT status
    FROM stock_reservations
    WHERE reservation_id = ${reservationId}
      AND session_id = ${session.id}
  `;

  if (!reservation.length) {
    throw new Error(
      "Prenotazione inventario non trovata: " + session.id
    );
  }

  if (reservation[0].status === "released") {
    throw new Error(
      "ATTENZIONE: pagamento riuscito dopo il rilascio delle scorte: " +
      session.id
    );
  }

  if (reservation[0].status === "pending") {
    const confirmed = await confirmReservation(
      sql,
      session.id
    );

    if (!confirmed) {
      throw new Error(
        "Impossibile confermare le scorte: " + session.id
      );
    }
  }

  if (reservation[0].status !== "pending" &&
      reservation[0].status !== "confirmed") {
    throw new Error(
      "Stato prenotazione non valido: " + session.id
    );
  }

  // Registra il tentativo di invio email.
  await sql`
    CREATE TABLE IF NOT EXISTS processed_order_emails (
      session_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const claim = await sql`
    INSERT INTO processed_order_emails (session_id)
    VALUES (${session.id})
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id
  `;

  // Se l'email è già stata elaborata, non duplicarla.
  if (!claim.length) {
    console.log("Email già elaborata:", session.id);
    return;
  }

  try {
    const order = await buildOrder(session);
    await sendEmail(order);

    console.log("EMAIL ORDINE INVIATA:", session.id);

  } catch (error) {
    // Elimina il tentativo fallito:
    // Stripe potrà ritentare il webhook.
    await sql`
      DELETE FROM processed_order_emails
      WHERE session_id = ${session.id}
    `;

    throw error;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const signature = req.headers["stripe-signature"];

  if (!signature) {
    return res.status(400).json({
      error: "Firma Stripe mancante"
    });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET non configurata");

    return res.status(500).json({
      error: "Configurazione webhook mancante"
    });
  }

  let event;

  // Verifica la firma usando il corpo originale.
  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (error) {
    console.error("ERRORE FIRMA STRIPE:", error.message);

    return res.status(400).json({
      error: "Firma Stripe non valida"
    });
  }

  try {
    const sql = getSql();

    if (event.type === "checkout.session.completed") {
      await processCompletedSession(
        sql,
        event.data.object
      );
    }

    if (
      event.type === "checkout.session.expired" ||
      event.type === "checkout.session.async_payment_failed"
    ) {
      const session = event.data.object;

      await releaseReservation(sql, session.id);
    }

    return res.status(200).json({
      received: true
    });

  } catch (error) {
    console.error("WEBHOOK ERROR:", error);

    // 500: Stripe può riprovare la consegna.
    return res.status(500).json({
      error: "Errore durante la gestione dell'ordine"
    });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
