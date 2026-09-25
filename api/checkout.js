const Stripe = require("stripe");

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  try {
    const { items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Carrello vuoto"
      });
    }

    const baseUrl =
      process.env.PUBLIC_URL ||
      `https://${req.headers.host}`;

    const catalogResponse = await fetch(
      `${baseUrl}/api/products`,
      {
        cache: "no-store"
      }
    );

    if (!catalogResponse.ok) {
      throw new Error("Catalogo non disponibile");
    }

    const catalogData =
      await catalogResponse.json();

    const products =
      Array.isArray(catalogData.products)
        ? catalogData.products
        : [];

    if (products.length === 0) {
      throw new Error(
        "Nessun prodotto disponibile"
      );
    }

    const line_items = items.map(item => {
      const product = products.find(
        product => product.id === item.id
      );

      if (!product) {
        throw new Error(
          "Prodotto non valido"
        );
      }

      const quantity = Math.max(
        1,
        Math.min(
          10,
          Number(item.quantity) || 1
        )
      );

      const unitAmount = Math.round(
        Number(product.price) * 100
      );

      if (
        !Number.isFinite(unitAmount) ||
        unitAmount <= 0
      ) {
        throw new Error(
          "Prezzo prodotto non valido"
        );
      }

      return {
        price_data: {
          currency: "eur",

          product_data: {
            name: String(product.name)
          },

          unit_amount: unitAmount
        },

        quantity
      };
    });

    const session =
      await stripe.checkout.sessions.create({

        mode: "payment",

        payment_method_types: [
          "card"
        ],

        line_items,

        shipping_address_collection: {
          allowed_countries: [
            "IT"
          ]
        },

        phone_number_collection: {
          enabled: true
        },

        billing_address_collection: "auto",

        customer_creation: "always",

        success_url:
          `${baseUrl}/?pagamento=successo`,

        cancel_url:
          `${baseUrl}/?pagamento=annullato`
      });

    return res.status(200).json({
      url: session.url
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error:
        "Impossibile creare il pagamento"
    });
  }
};
