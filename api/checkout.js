const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const shippingOptions = {
  north: {
    name: "Spedizione Nord Italia",
    amount: 500
  },
  center: {
    name: "Spedizione Centro Italia",
    amount: 600
  },
  south: {
    name: "Spedizione Sud Italia",
    amount: 700
  },
  islands: {
    name: "Spedizione Sicilia e Sardegna",
    amount: 900
  }
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  try {
    const { items, shippingZone } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Carrello vuoto"
      });
    }

    const shipping = shippingOptions[shippingZone];

    if (!shipping) {
      return res.status(400).json({
        error: "Zona di spedizione non valida"
      });
    }

    const line_items = [];

    for (const item of items) {
      const name = String(item.name || "").trim();

      const price = Number(item.price);

      const quantity = Number(
        item.quantity ?? item.qty ?? 1
      );

      if (
        !name ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          error: "Prodotto non valido"
        });
      }

      line_items.push({
        price_data: {
          currency: "eur",

          product_data: {
            name
          },

          unit_amount: Math.round(price * 100)
        },

        quantity
      });
    }

    // COSTO SPEDIZIONE
    line_items.push({
      price_data: {
        currency: "eur",

        product_data: {
          name: shipping.name
        },

        unit_amount: shipping.amount
      },

      quantity: 1
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      payment_method_types: ["card"],

      line_items,

      shipping_address_collection: {
        allowed_countries: ["IT"]
      },

      phone_number_collection: {
        enabled: true
      },

      billing_address_collection: "auto",

      customer_creation: "always",

      metadata: {
        shippingZone
      },

      success_url:
        `${process.env.PUBLIC_URL}/?success=1`,

      cancel_url:
        `${process.env.PUBLIC_URL}/?cancel=1`
    });

    return res.status(200).json({
      url: session.url
    });

  } catch (error) {
    console.error("CHECKOUT ERROR:", error);

    return res.status(500).json({
      error: "Impossibile creare il pagamento"
    });
  }
};
