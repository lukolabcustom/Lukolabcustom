
const Stripe = require("stripe");
const { neon } = require("@neondatabase/serverless");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const RESEND_API_URL = "https://api.resend.com/emails";

function getSql() {
  const url =
    process.env.neon_POSTGRES_URL ||
    process.env.neon_POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL;

  if (!url) throw new Error("Connessione Neon non configurata");

  return neon(url);
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
  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding:8px 0">${escapeHtml(item.name)}</td>
      <td style="padding:8px 0;text-align:center">${item.quantity}</td>
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
    throw new Error(data.message || "Errore invio email Resend");
  }

  return data;
}

async function releaseReservation(sql, sessionId) {
  // Una sola richiesta può cambiare una prenotazione da pending a released.
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

  // Ripristina le quantità precedentemente prenotate.
  for (const item of items) {
    if (!item.size) continue;

    await sql`
      UPDATE product_stock
      SET quantity = quantity + ${Number(item.quantity)}
      WHERE product_id = ${item.id}
        AND size = ${item.size}
    `;
  }
}

async function confirmReservation(sql, sessionId) {
  // Evita di confermare due volte la stessa prenotazione.
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
    .filter(item => !String(item.description || "").startsWith("Spedizione "))
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  try {
    const signature = req.headers["stripe-signature"];

    if (!signature) {
      return res.status(400).json({ error: "Firma Stripe mancante" });
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error("STRIPE_WEBHOOK_SECRET non configurata");
    }

    // Il body deve essere quello originale ricevuto da Stripe.
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : req.body;

    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    const sql = getSql();

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Per questa integrazione accettiamo solo pagamenti realmente riusciti.
      if (session.payment_status !== "paid") {
        return res.status(200).json({
          received: true,
          message: "Pagamento non ancora completato"
        });
      }

      const reservationId = session.metadata?.reservationId;

      if (!reservationId) {
        console.error("Prenotazione mancante per sessione", session.id);
        return res.status(500).json({
          error: "Prenotazione inventario non trovata"
        });
      }

      // Associa la prenotazione alla sessione, anche se la notifica arriva
      // prima che il checkout abbia salvato session_id.
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
        return res.status(500).json({
          error: "Prenotazione inventario non trovata"
        });
      }

      if (reservation[0].status === "released") {
        console.error("Pagamento riuscito dopo rilascio scorte", session.id);
        return res.status(500).json({
          error: "Scorte già rilasciate: verifica manuale necessaria"
        });
      }

      if (reservation[0].status === "pending") {
        const confirmed = await confirmReservation(sql, session.id);

        if (!confirmed) {
          return res.status(500).json({
            error: "Impossibile confermare la prenotazione"
          });
        }
      }

      // Il webhook può essere ritentato: evita di inviare nuovamente
      // l'email se la notifica era già stata gestita.
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

      if (claim.length) {
        const order = await buildOrder(session);
        await sendEmail(order);
      }
    }

    if (
      event.type === "checkout.session.expired" ||
      event.type === "checkout.session.async_payment_failed"
    ) {
      const session = event.data.object;
      await releaseReservation(sql, session.id);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("WEBHOOK ERROR:", error);

    return res.status(400).json({
      error: error.message || "Errore webhook"
    });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
