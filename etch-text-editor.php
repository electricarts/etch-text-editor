<?php
/**
 * Plugin Name:       Etch Text Editor
 * Plugin URI:        https://github.com/electricarts/etch-text-editor
 * Description:       Edit text blocks directly in the Etch builder – Gutenberg blocks (core/paragraph, core/heading, …) AND Etch text elements – including inline formatting (link, bold, italic, font-weight) and a canvas preview for Gutenberg content. Normal editing preserves Gutenberg blocks; standalone paragraphs can be manually converted to native Etch text elements.
 * Version:           1.0.17
 * Author:            Mario Peischl
 * Author URI:        https://electricarts.de
 * Requires at least: 6.0
 * Requires PHP:      7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The script polls for window.etch and stops itself when no Etch builder
 * is present on the page. It therefore has no effect on normal
 * front-end / admin pages.
 */
function eppe_enqueue() {
	if ( ! is_user_logged_in() || ! current_user_can( 'edit_posts' ) ) {
		return;
	}
	wp_enqueue_script(
		'etch-text-editor',
		plugin_dir_url( __FILE__ ) . 'editor.js',
		array(),
		'1.0.17',
		true
	);
}
add_action( 'wp_enqueue_scripts', 'eppe_enqueue' );
add_action( 'admin_enqueue_scripts', 'eppe_enqueue' );
