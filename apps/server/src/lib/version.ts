/**
 * Версия панели: релизный образ получает её при сборке (ARG PANEL_VERSION из тега vX.Y.Z),
 * сборка из исходников - "dev". PANEL_COMMIT - короткий коммит сборки.
 */
export const PANEL_VERSION = process.env.PANEL_VERSION?.trim() || 'dev';
export const PANEL_COMMIT = process.env.PANEL_COMMIT?.trim() || '';
