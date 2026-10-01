const Stripe = require("stripe");

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);

const RESEND_API_URL =
  "https://api.resend.com/emails";

async function sendEmail(order) {

  const itemsHtml =
    order.items
      .map(item => `
        <tr>
          <td style="padding:8px 0;">
            ${escapeHtml(item.name)}
          </td>

          <td style="padding:8px 0;text-align:center;">
            ${item.quantity}
          </td>

          <td style="padding:8px 0;text-align:right;">
            €${(item.amount / 100).toFixed(2)}
          </td>
        </tr>
      `)
      .join("");


  const html = `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;">

      <h1>🌴 Nuovo ordine Luko Lab Custom</h1>

      <p>
        Hai ricevuto un nuovo pagamento.
      </p>

      <hr>

      <h2>🛍️ Prodotti</h2>

      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;">Prodotto</th>
            <th>Qtà</th>
            <th style="text-align:right;">Prezzo</th>
          </tr>
        </thead>

        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <hr>

      <h2>👤 Cliente</h2>

      <p>
        <strong>Nome:</strong>
        ${escapeHtml(order.name)}
      </p>

      <p>
        <strong>Email:</strong>
        ${escapeHtml(order.email)}
      </p>

      <p>
        <strong>Telefono:</strong>
        ${escapeHtml(order.phone)}
      </p>

      <h2>📍 Spedizione</h2>

      <p>
        ${escapeHtml(order.address)}
      </p>

      <p>
        <strong>Zona:</strong>
        ${escapeHtml(order.shippingZone)}
      </p>

      <h2>💰 Totale</h2>

      <p style="font-size:24px;font-weight:bold;">
        €${(order.total / 100).toFixed(2)}
      </p>

      <hr>

      <p>
        ID ordine Stripe:
        ${escapeHtml(order.sessionId)}
      </p>

    </div>
  `;


  const response =
    await fetch(
      RESEND_API_URL,
      {
        method: "POST",

        headers: {
          "Authorization":
            `Bearer ${process.env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({

          from:
            "Luko Lab Custom <onboarding@resend.dev>",

          to:
            ["Lukolabcustom@gmail.com"],

          subject:
            "🌴 Nuovo ordine Luko Lab Custom",

          html
        })
      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    throw new Error(
      data.message ||
      "Errore invio email Resend"
    );
  }


  return data;
}


function escapeHtml(value) {

  return String(
    value || ""
  )
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


module.exports = async function handler(
  req,
  res
) {

  if (req.method !== "POST") {

    return res.status(405).json({
      error:
        "Metodo non consentito"
    });
  }


  try {

    /*
      Stripe deve inviare
      l'evento con la firma.
    */

    const signature =
      req.headers[
        "stripe-signature"
      ];


    if (!signature) {

      return res.status(400).json({
        error:
          "Firma Stripe mancante"
      });
    }


    /*
      Vercel fornisce il body
      già disponibile nella richiesta.
    */

    const event =
      stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );


    /*
      Ci interessa solo quando
      il pagamento è completato.
    */

    if (
      event.type ===
      "checkout.session.completed"
    ) {

      const session =
        event.data.object;


      /*
        Recuperiamo tutti i prodotti
        acquistati.
      */

      const lineItems =
        await stripe.checkout.sessions.listLineItems(
          session.id,
          {
            limit: 100
          }
        );


      const items =
        lineItems.data
          .map(item => ({
            name:
              item.description ||
              "Prodotto",

            quantity:
              item.quantity || 1,

            amount:
              item.amount_total || 0
          }));


      const customerDetails =
        session.customer_details || {};


      const address =
        customerDetails.address || {};


      const addressText = [
        address.line1,
        address.line2,
        address.postal_code,
        address.city,
        address.state,
        address.country
      ]
        .filter(Boolean)
        .join(", ");


      const shippingZone =
        session.metadata?.shippingZone ||
        "Non specificata";


      const order = {

        sessionId:
          session.id,

        name:
          customerDetails.name ||
          "Non specificato",

        email:
          customerDetails.email ||
          "Non specificata",

        phone:
          customerDetails.phone ||
          "Non specificato",

        address:
          addressText ||
          "Non specificato",

        shippingZone,

        total:
          session.amount_total || 0,

        items
      };


      await sendEmail(order);
    }


    return res.status(200).json({
      received: true
    });


  } catch (error) {

    console.error(
      "WEBHOOK ERROR:",
      error
    );

    return res.status(400).json({
      error:
        error.message ||
        "Errore webhook"
    });
  }
};


/*
  IMPORTANTE:
  Stripe deve ricevere il body
  originale per verificare la firma.
*/

module.exports.config = {
  api: {
    bodyParser: false
  }
};
