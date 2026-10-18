#!/bin/sh
# Idempotent store setup, run by the Helm post-install/post-upgrade hook Job (WP-CLI image,
# as uid 33 so files match the Apache image's www-data). Safe to re-run.
set -eu
cd /var/www/html
log() { echo "[setup] $*"; }
wpu() { wp --user="$WP_ADMIN_USER" "$@"; }
# Cosmetic options: Woo hooks can make update_option() report failure on a fresh install.
soft() { wp option update "$@" || log "warning: could not set $1 (non-fatal)"; }

log "waiting for WordPress files on the shared volume"
i=0
until [ -f wp-config.php ] && [ -f wp-includes/version.php ]; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { log "timed out waiting for files"; exit 1; }
  sleep 5
done

log "waiting for MySQL"
i=0
until php -r 'mysqli_report(MYSQLI_REPORT_OFF); $m = @new mysqli(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")); exit($m->connect_errno ? 1 : 0);'; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { log "timed out waiting for MySQL"; exit 1; }
  sleep 5
done

log "WordPress core $(wp core version)"
if wp core is-installed; then
  log "core already installed"
else
  wp core install --url="$WP_HOME_URL" --title="$STORE_TITLE" --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi
wp option update home "$WP_HOME_URL" >/dev/null
wp option update siteurl "$WP_HOME_URL" >/dev/null
# Pretty permalinks: the Woo REST API lives under /wp-json/.
wp rewrite structure '/%postname%/' >/dev/null
wp rewrite flush

current=$(wp plugin get woocommerce --field=version 2>/dev/null || true)
if [ "$current" != "$WOO_VERSION" ]; then
  log "installing WooCommerce $WOO_VERSION (found: ${current:-none})"
  # wordpress.org downloads from inside the cluster fail now and then: retry before failing the Job.
  for try in 1 2 3; do
    wp plugin install woocommerce --version="$WOO_VERSION" --force && break
    [ "$try" = 3 ] && exit 1
    log "WooCommerce download failed (attempt $try); retrying in 10 s"; sleep 10
  done
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce
log "WooCommerce $(wp plugin get woocommerce --field=version) active"

log "store settings"
wp option update woocommerce_coming_soon no
wp option update woocommerce_store_pages_only no
wp option update woocommerce_default_country "$STORE_COUNTRY"
wp option update woocommerce_currency "$STORE_CURRENCY"
wp option update timezone_string "$STORE_TIMEZONE"
# W1: the MCP server must be our own code, so WooCommerce's built-in MCP feature stays off.
wp option update woocommerce_feature_mcp_integration_enabled no
soft woocommerce_allow_tracking no
soft woocommerce_show_marketplace_suggestions no
soft woocommerce_task_list_hidden yes
soft woocommerce_onboarding_profile '{"skipped":true}' --format=json
wpu wc tool run install_pages >/dev/null
wpu wc payment_gateway update cod --enabled=true >/dev/null
if [ "$(wpu wc shipping_zone_method list 0 --format=count)" = "0" ]; then
  log "adding free shipping to the default zone"
  wpu wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true >/dev/null
fi

log "seeding products"
while IFS='|' read -r sku name price; do
  [ -n "$sku" ] || continue
  if [ "$(wp post list --post_type=product --post_status=any --meta_key=_sku --meta_value="$sku" --format=count)" = "0" ]; then
    wpu wc product create --sku="$sku" --name="$name" --regular_price="$price" --status=publish --porcelain >/dev/null
    log "  created $sku"
  fi
done < /setup/products.txt

log "REST API key"
wp eval-file /setup/api-key.php

log "summary"
wp plugin list --status=active --fields=name,version
wp option list --search='*mcp*' --fields=option_name,option_value
echo "home=$(wp option get home) timezone=$(wp option get timezone_string) products=$(wp post list --post_type=product --post_status=publish --format=count) cod=$(wpu wc payment_gateway get cod --field=enabled)"
log "done"
