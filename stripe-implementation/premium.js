/* ================================================================
   Bible Words — Premium / Stripe client integration (drop-in)
   ---------------------------------------------------------------
   This file is linked from index.html (2026-11-14) with:

     <script src="stripe-implementation/premium.js"></script>

   At the deploy step, keep the same relative path (upload this
   file to stripe-implementation/premium.js in the repo) — see
   IMPLEMENTATION.md. Nothing in this file contains or needs a
   Stripe secret key — secret keys must never appear in
   client-side code.

   Two routes are supported (see IMPLEMENTATION.md):

   Route A (primary, no backend):
     - Subscribe button -> Stripe Payment Link (hosted by Stripe).
     - "Manage subscription" -> Stripe Billing Portal login link.
     - After Stripe redirects back with ?premium=welcome, Premium is
       marked active ON THIS DEVICE ONLY (localStorage). There is no
       account system, so this is a convenience unlock, not proof of
       payment. Anyone who edits localStorage can unlock it, and it
       does not follow the customer to another device.

   Route B (serverless, stronger):
     - Subscribe button -> POST to a small worker that creates a
       real Checkout Session (mode: subscription) and returns its
       URL. Webhooks on the worker are the source of truth for who
       paid; the worker can later be asked for entitlement status.
     - Set CONFIG.mode = "worker" and CONFIG.workerBaseUrl.
   ================================================================ */
(function () {
  "use strict";

  var CONFIG = {
    // "payment-link" (Route A) or "worker" (Route B)
    mode: "payment-link",

    // Route A — fill these in from the Stripe Dashboard.
    // Payment Link: Billing > Payment Links > create for the live
    //   price price_1UbdXgKMc4ImpfPh7YJflact ($231/month).
    //   Set its after-payment redirect to:
    //   https://theworld-bible.github.io/bible-words/?premium=welcome
    paymentLinkUrl: "https://buy.stripe.com/3cIcN67Vdbe81wW7lQcIE01",

    // Billing Portal login link: Settings > Billing > Customer
    // portal > portal login link (configuration
    // bpc_1UbdrLKMc4ImpfPhRSOOoXDN is already created & active).
    portalLinkUrl: "https://billing.stripe.com/p/login/fZu14o4J1gysa3sbC6cIE00",

    // Route B — base URL of the Cloudflare Worker in ./worker/
    workerBaseUrl: "", // e.g. "https://bible-words-stripe.example.workers.dev",

    // Display price (must match Stripe). Base price is JPY 36,900.
    priceDisplay: "$231",
    pricePeriod: "/ month",

    // localStorage keys (bw_premium in index.html means "reserved";
    // keep the paid flag separate so the two never get confused).
    storageKeyActive: "bw_premium_active",
    storageKeyCustomer: "bw_stripe_customer"
  };

  /* ---------------- state helpers ---------------- */

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* private mode */ }
  }

  function isPremium() {
    return lsGet(CONFIG.storageKeyActive) === "1";
  }

  // Stable per-device id. Under Route B this is sent as
  // client_reference_id so webhooks can be tied back to this device
  // as far as a no-account app allows.
  function deviceId() {
    var id = lsGet("bw_device_id");
    if (!id) {
      id = "dev-" + Date.now().toString(36) + "-" +
        Math.random().toString(36).slice(2, 10);
      lsSet("bw_device_id", id);
    }
    return id;
  }

  /* ---------------- return handling ---------------- */

  // Stripe (Payment Link or Checkout) redirects back to the site
  // with ?premium=welcome after a completed payment.
  // NOTE (Route A honesty): reaching this URL is treated as
  // "paid on this device". It is not cryptographic proof — the
  // Payment Link redirect can be typed by hand. Acceptable for a
  // no-account app whose paid extras are device-local, and stated
  // plainly in IMPLEMENTATION.md. Route B removes this weakness by
  // checking entitlement with the worker (webhook-verified).
  function handleReturn() {
    var params;
    try { params = new URLSearchParams(window.location.search); }
    catch (e) { return; }
    if (params.get("premium") === "welcome" || params.get("checkout") === "success") {
      lsSet(CONFIG.storageKeyActive, "1");
      // Clean the URL so a refresh/share doesn't re-trigger it.
      try {
        var url = new URL(window.location.href);
        url.searchParams.delete("premium");
        url.searchParams.delete("checkout");
        url.searchParams.delete("session_id");
        window.history.replaceState({}, "", url.toString());
      } catch (e) { /* non-fatal */ }
      document.dispatchEvent(new CustomEvent("bw:premium-activated"));
    }
    if (params.get("checkout") === "cancelled") {
      document.dispatchEvent(new CustomEvent("bw:checkout-cancelled"));
    }
  }

  /* ---------------- checkout entry points ---------------- */

  function startCheckout() {
    if (CONFIG.mode === "worker") return startCheckoutViaWorker();
    if (!CONFIG.paymentLinkUrl) {
      // Not configured yet: fail soft to the existing behaviour
      // (interest reservation in index.html) instead of a dead end.
      document.dispatchEvent(new CustomEvent("bw:checkout-not-configured"));
      return Promise.resolve(false);
    }
    var url = CONFIG.paymentLinkUrl;
    // Payment Links accept a prefilled client_reference_id via
    // query string only when the link is configured for it; the
    // device id is appended so support can reconcile manually.
    url += (url.indexOf("?") === -1 ? "?" : "&") +
      "client_reference_id=" + encodeURIComponent(deviceId());
    window.location.href = url;
    return Promise.resolve(true);
  }

  function startCheckoutViaWorker() {
    if (!CONFIG.workerBaseUrl) {
      document.dispatchEvent(new CustomEvent("bw:checkout-not-configured"));
      return Promise.resolve(false);
    }
    return fetch(CONFIG.workerBaseUrl + "/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientReferenceId: deviceId() })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.url) { window.location.href = data.url; return true; }
        throw new Error("No checkout URL returned");
      })
      .catch(function () {
        document.dispatchEvent(new CustomEvent("bw:checkout-error"));
        return false;
      });
  }

  function openPortal() {
    if (CONFIG.mode === "worker" && CONFIG.workerBaseUrl && lsGet(CONFIG.storageKeyCustomer)) {
      return fetch(CONFIG.workerBaseUrl + "/create-portal-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: lsGet(CONFIG.storageKeyCustomer) })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.url) { window.location.href = data.url; return true; }
          throw new Error("No portal URL returned");
        })
        .catch(function () { return false; });
    }
    if (CONFIG.portalLinkUrl) {
      window.location.href = CONFIG.portalLinkUrl;
      return Promise.resolve(true);
    }
    document.dispatchEvent(new CustomEvent("bw:checkout-not-configured"));
    return Promise.resolve(false);
  }

  /* ---------------- optional button wiring ----------------
     If elements with these ids exist they are wired up. Since
     2026-11-14, index.html also calls startCheckout()/openPortal()
     directly from its own Premium buttons (#btn-reserve,
     #ob-reserve) and shows a "Manage subscription" entry
     (#btn-manage-subscription) when isPremium() is true. */

  function wire() {
    var sub = document.getElementById("btn-subscribe");
    if (sub) sub.addEventListener("click", startCheckout);
    var portal = document.getElementById("btn-portal");
    if (portal) portal.addEventListener("click", openPortal);
    var priceEls = document.querySelectorAll("[data-bw-price]");
    for (var i = 0; i < priceEls.length; i++) {
      priceEls[i].textContent = CONFIG.priceDisplay;
    }
    if (isPremium()) {
      document.documentElement.classList.add("bw-premium-active");
      if (sub) { sub.textContent = "Premium is active ✦"; sub.setAttribute("disabled", ""); }
    }
  }

  handleReturn();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else { wire(); }

  // Public surface for index.html feature gates, e.g.:
  //   if (window.BibleWordsPremium.isPremium()) { ...extended plan... }
  window.BibleWordsPremium = {
    config: CONFIG,
    isPremium: isPremium,
    startCheckout: startCheckout,
    openPortal: openPortal,
    deviceId: deviceId
  };
})();
