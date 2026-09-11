-- Multi-vertical delivery platform schema (PostgreSQL)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'customer', -- customer | merchant | rider | dispatcher | fleet | finance | admin
  lang TEXT NOT NULL DEFAULT 'en',
  store_id INT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zones (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  polygon JSONB NOT NULL,            -- [[lat,lng],...]
  base_fee NUMERIC(10,2) NOT NULL DEFAULT 10,
  per_km NUMERIC(10,2) NOT NULL DEFAULT 2,
  min_order NUMERIC(10,2) NOT NULL DEFAULT 20,
  service_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 5,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  name_en TEXT NOT NULL, name_ar TEXT,
  vertical TEXT NOT NULL,             -- food | grocery | pharmacy
  zone_id INT REFERENCES zones(id),
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | busy | closed
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 15,
  prep_time_min INT NOT NULL DEFAULT 20,
  rating NUMERIC(3,2) DEFAULT 0, rating_count INT DEFAULT 0,
  image TEXT,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_store_fk') THEN
    ALTER TABLE users ADD CONSTRAINT users_store_fk FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  store_id INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL, name_ar TEXT, sort INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  store_id INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  name_en TEXT NOT NULL, name_ar TEXT, description TEXT,
  price NUMERIC(10,2) NOT NULL,
  unit TEXT NOT NULL DEFAULT 'each',   -- each | kg | g | ltr
  stock INT,                           -- NULL = untracked
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE, -- e.g. prescription
  attributes JSONB NOT NULL DEFAULT '{}', -- modifiers etc.
  image TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS addresses (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT, line TEXT, notes TEXT,
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS riders (
  id SERIAL PRIMARY KEY,
  user_id INT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone_id INT REFERENCES zones(id),
  vehicle TEXT DEFAULT 'motorbike',
  status TEXT NOT NULL DEFAULT 'offline', -- offline | available | on_task | break
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, last_seen TIMESTAMPTZ,
  cash_in_hand NUMERIC(10,2) NOT NULL DEFAULT 0,
  cash_limit NUMERIC(10,2) NOT NULL DEFAULT 1500,
  deliveries INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  rider_id INT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  clock_in TIMESTAMPTZ NOT NULL DEFAULT NOW(), clock_out TIMESTAMPTZ,
  cash_settled NUMERIC(10,2)
);

CREATE TABLE IF NOT EXISTS promos (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'percent', -- percent | fixed | free_delivery
  value NUMERIC(10,2) NOT NULL DEFAULT 0,
  min_order NUMERIC(10,2) DEFAULT 0,
  vertical TEXT, max_uses INT, used INT NOT NULL DEFAULT 0,
  first_order_only BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'store',  -- store | parcel
  vertical TEXT NOT NULL,              -- food | grocery | pharmacy | parcel
  customer_id INT NOT NULL REFERENCES users(id),
  store_id INT REFERENCES stores(id),
  zone_id INT REFERENCES zones(id),
  rider_id INT REFERENCES riders(id),
  status TEXT NOT NULL DEFAULT 'placed',
  items JSONB NOT NULL DEFAULT '[]',
  dropoff JSONB NOT NULL,              -- {lat,lng,line,notes,phone,name}
  pickup JSONB,                        -- parcel only
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  service_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL DEFAULT 0,
  promo_code TEXT,
  payment_method TEXT NOT NULL DEFAULT 'cod', -- cod | card | wallet
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | refunded | partial_refund
  cod_collect NUMERIC(10,2) DEFAULT 0,  -- parcel: cash to collect for sender
  prescription_url TEXT,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  prep_time_min INT,
  notes TEXT,
  assigned_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ, proof_url TEXT,
  rating INT, rating_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id);
CREATE INDEX IF NOT EXISTS orders_store_idx ON orders(store_id);

CREATE TABLE IF NOT EXISTS order_events (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  actor_role TEXT, actor_id INT, note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id),
  account TEXT NOT NULL,   -- cash_riders | card_gateway | merchant_payable | commission_revenue | delivery_revenue | service_revenue | discounts | refunds | customer_wallet
  party_id INT,            -- store_id / rider_id / user_id depending on account
  debit NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit NUMERIC(12,2) NOT NULL DEFAULT 0,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC(10,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INT, action TEXT NOT NULL, target TEXT, detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
