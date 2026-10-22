<?php
// Create or update the read_write WooCommerce REST key for the MCP server, owned by the
// shop_manager service user (WOO_KEY_USER), never the administrator.
// Woo stores the consumer key as wc_api_hash(ck) and the secret in plain text.
global $wpdb;
$table = $wpdb->prefix . 'woocommerce_api_keys';
$ck = getenv('WOO_CONSUMER_KEY');
$cs = getenv('WOO_CONSUMER_SECRET');
$desc = getenv('WOO_KEY_DESCRIPTION');
$user = get_user_by('login', getenv('WOO_KEY_USER'));
if (!$ck || !$cs || !$user) {
	WP_CLI::error('missing consumer key/secret or the MCP service user');
}
if (in_array('administrator', (array) $user->roles, true)) {
	WP_CLI::error('the MCP service user must not be an administrator');
}
$data = array(
	'user_id'         => $user->ID,
	'description'     => $desc,
	'permissions'     => 'read_write',
	'consumer_key'    => wc_api_hash($ck),
	'consumer_secret' => $cs,
	'truncated_key'   => substr($ck, -7),
);
$id = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM {$table} WHERE description = %s", $desc));
if ($id) {
	$wpdb->update($table, $data, array('key_id' => $id));
	WP_CLI::log("api key '{$desc}' updated (key_id {$id}, ...{$data['truncated_key']})");
} else {
	$wpdb->insert($table, $data);
	WP_CLI::log("api key '{$desc}' created (key_id {$wpdb->insert_id}, ...{$data['truncated_key']})");
}
