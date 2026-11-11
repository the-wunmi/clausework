-- The demo clock left the product with mock mode. A database used for demos may still hold its
-- offset, which would keep every rule running days ahead of PayPal.
DELETE FROM "settings" WHERE "key" = 'clock';
