<?php
/**
 * Plugin Name:       Etch Text Editor
 * Plugin URI:        https://github.com/electricarts/etch-text-editor
 * Description:       Edit text blocks directly in the Etch builder – Gutenberg blocks (core/paragraph, core/heading, …) AND Etch text elements – including inline formatting (link, bold, italic, font-weight) and a canvas preview for Gutenberg content. Normal editing preserves Gutenberg blocks; standalone paragraphs can be manually converted to native Etch text elements.
 * Version:           1.0.22
 * Author:            Mario Peischl
 * Author URI:        https://electricarts.de
 * Update URI:        https://electricarts.de/etch-text-editor/
 * Requires at least: 6.0
 * Requires PHP:      7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'EPPE_VERSION', '1.0.22' );
define( 'EPPE_TESTED_WP_VERSION', '7.1.3' );
define( 'EPPE_PLUGIN_BASENAME', plugin_basename( __FILE__ ) );
define( 'EPPE_GITHUB_REPOSITORY', 'electricarts/etch-text-editor' );
define( 'EPPE_GITHUB_RELEASE_TRANSIENT', 'eppe_github_latest_release' );

function eppe_plugin_icon_url() {
	return plugin_dir_url( __FILE__ ) . 'assets/icon-128x128.png';
}

/**
 * Return the latest published GitHub release that contains the installable ZIP.
 *
 * The result is cached briefly so normal WordPress update checks do not make a
 * GitHub API request on every admin page load. A manual "Check again" bypasses
 * the cache via the force-check query parameter.
 *
 * @return array<string, string>|null
 */
function eppe_github_latest_release() {
	$force_check = isset( $_GET['force-check'] ) && '1' === (string) $_GET['force-check'];

	if ( ! $force_check ) {
		$cached = get_site_transient( EPPE_GITHUB_RELEASE_TRANSIENT );
		if ( is_array( $cached ) && ! empty( $cached['version'] ) && ! empty( $cached['package'] ) ) {
			return $cached;
		}
	}

	$response = wp_safe_remote_get(
		'https://api.github.com/repos/' . EPPE_GITHUB_REPOSITORY . '/releases/latest',
		array(
			'timeout'     => 8,
			'headers'     => array(
				'Accept'               => 'application/vnd.github+json',
				'X-GitHub-Api-Version' => '2022-11-28',
				'User-Agent'           => 'Etch-Text-Editor/' . EPPE_VERSION . '; ' . home_url( '/' ),
			),
		)
	);

	if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
		return null;
	}

	$data = json_decode( wp_remote_retrieve_body( $response ), true );
	if ( ! is_array( $data ) || ! empty( $data['draft'] ) || ! empty( $data['prerelease'] ) ) {
		return null;
	}

	$tag = isset( $data['tag_name'] ) ? (string) $data['tag_name'] : '';
	$version = preg_replace( '/^v/i', '', $tag );
	if ( ! is_string( $version ) || ! preg_match( '/^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/', $version ) ) {
		return null;
	}

	$package = '';
	$assets  = isset( $data['assets'] ) && is_array( $data['assets'] ) ? $data['assets'] : array();
	$expected_asset = 'etch-text-editor-' . $version . '.zip';

	foreach ( $assets as $asset ) {
		if ( ! is_array( $asset ) || $expected_asset !== ( $asset['name'] ?? '' ) ) {
			continue;
		}

		$url = isset( $asset['browser_download_url'] ) ? (string) $asset['browser_download_url'] : '';
		if ( 0 === strpos( $url, 'https://github.com/' . EPPE_GITHUB_REPOSITORY . '/releases/download/' ) ) {
			$package = $url;
			break;
		}
	}

	if ( '' === $package ) {
		return null;
	}

	$release = array(
		'version' => $version,
		'package' => $package,
		'url'     => 'https://github.com/' . EPPE_GITHUB_REPOSITORY . '/releases/tag/' . rawurlencode( $tag ),
	);

	set_site_transient( EPPE_GITHUB_RELEASE_TRANSIENT, $release, HOUR_IN_SECONDS );

	return $release;
}

/**
 * Build the update object expected by WordPress' plugin upgrader.
 *
 * @param array<string, string> $release GitHub release data.
 * @return object
 */
function eppe_build_update_object( $release ) {
	return (object) array(
		'id'            => EPPE_PLUGIN_BASENAME,
		'slug'          => 'etch-text-editor',
		'plugin'        => EPPE_PLUGIN_BASENAME,
		'version'       => $release['version'],
		'new_version'   => $release['version'],
		'url'           => $release['url'],
		'package'       => $release['package'],
		'tested'        => EPPE_TESTED_WP_VERSION,
		'requires'      => '6.0',
		'requires_php'  => '7.4',
		'icons'         => array(
			'1x' => eppe_plugin_icon_url(),
		),
		'banners'       => array(),
		'banners_rtl'   => array(),
		'compatibility' => new stdClass(),
	);
}

/**
 * Supply the update response through WordPress' Update URI host hook.
 *
 * @param false|object $update      Existing update response.
 * @param array        $plugin_data Installed plugin headers.
 * @param string       $plugin_file Plugin basename.
 * @param array        $locales     Installed locales.
 * @return false|object
 */
function eppe_update_from_github( $update, $plugin_data, $plugin_file, $locales ) {
	if ( EPPE_PLUGIN_BASENAME !== $plugin_file ) {
		return $update;
	}

	$release = eppe_github_latest_release();
	if ( ! is_array( $release ) ) {
		return false;
	}

	if ( ! version_compare( $release['version'], EPPE_VERSION, '>' ) ) {
		$release = array(
			'version' => EPPE_VERSION,
			'package' => '',
			'url'     => 'https://github.com/' . EPPE_GITHUB_REPOSITORY,
		);
	}

	return eppe_build_update_object( $release );
}
add_filter( 'update_plugins_electricarts.de', 'eppe_update_from_github', 10, 4 );

/**
 * Keep the classic plugin update transient populated as well. This makes the
 * update visible in the Plugins screen and keeps the auto-update UI working.
 *
 * @param object|mixed $transient Plugin update transient.
 * @return object|mixed
 */
function eppe_filter_plugin_update_transient( $transient ) {
	if ( ! is_object( $transient ) ) {
		return $transient;
	}

	$release = eppe_github_latest_release();
	if ( ! is_array( $release ) ) {
		return $transient;
	}

	if ( ! isset( $transient->response ) || ! is_array( $transient->response ) ) {
		$transient->response = array();
	}
	if ( ! isset( $transient->no_update ) || ! is_array( $transient->no_update ) ) {
		$transient->no_update = array();
	}

	if ( version_compare( $release['version'], EPPE_VERSION, '>' ) ) {
		$transient->response[ EPPE_PLUGIN_BASENAME ] = eppe_build_update_object( $release );
		unset( $transient->no_update[ EPPE_PLUGIN_BASENAME ] );
	} else {
		$transient->no_update[ EPPE_PLUGIN_BASENAME ] = eppe_build_update_object(
			array(
				'version' => EPPE_VERSION,
				'package' => '',
				'url'     => 'https://github.com/' . EPPE_GITHUB_REPOSITORY,
			)
		);
	}

	return $transient;
}
add_filter( 'pre_set_site_transient_update_plugins', 'eppe_filter_plugin_update_transient' );

/**
 * Provide the details shown by the WordPress plugin update modal.
 *
 * @param false|object $result Existing API response.
 * @param string       $action API action.
 * @param object       $args   API arguments.
 * @return false|object
 */
function eppe_plugin_information( $result, $action, $args ) {
	if ( 'plugin_information' !== $action || ! is_object( $args ) || empty( $args->slug ) || 'etch-text-editor' !== $args->slug ) {
		return $result;
	}

	$release = eppe_github_latest_release();
	if ( ! is_array( $release ) ) {
		return $result;
	}

	return (object) array(
		'name'          => 'Etch Text Editor',
		'slug'          => 'etch-text-editor',
		'version'       => $release['version'],
		'author'        => 'Mario Peischl',
		'homepage'      => 'https://github.com/' . EPPE_GITHUB_REPOSITORY,
		'tested'        => EPPE_TESTED_WP_VERSION,
		'requires'      => '6.0',
		'requires_php'  => '7.4',
		'download_link' => $release['package'],
		'icons'         => array(
			'1x' => eppe_plugin_icon_url(),
		),
		'last_updated'  => '',
		'sections'      => array(
			'description' => '<p>Graphical text editing for Etch builder text elements and Gutenberg passthrough blocks.</p>',
			'changelog'   => '<p><a href="' . esc_url( $release['url'] ) . '" target="_blank" rel="noopener">View the release changelog on GitHub</a>.</p>',
		),
	);
}
add_filter( 'plugins_api', 'eppe_plugin_information', 10, 3 );

/**
 * Fetch a fresh release after a successful plugin upgrade.
 *
 * @param object $upgrader   Upgrader instance.
 * @param array  $hook_extra Upgrade context.
 * @return void
 */
function eppe_clear_release_cache_after_upgrade( $upgrader, $hook_extra ) {
	$plugins = array();

	if ( ! empty( $hook_extra['plugin'] ) ) {
		$plugins[] = $hook_extra['plugin'];
	}
	if ( ! empty( $hook_extra['plugins'] ) && is_array( $hook_extra['plugins'] ) ) {
		$plugins = array_merge( $plugins, $hook_extra['plugins'] );
	}

	if ( in_array( EPPE_PLUGIN_BASENAME, $plugins, true ) ) {
		delete_site_transient( EPPE_GITHUB_RELEASE_TRANSIENT );
	}
}
add_action( 'upgrader_process_complete', 'eppe_clear_release_cache_after_upgrade', 10, 2 );

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
		EPPE_VERSION,
		true
	);
}
add_action( 'wp_enqueue_scripts', 'eppe_enqueue' );
add_action( 'admin_enqueue_scripts', 'eppe_enqueue' );
