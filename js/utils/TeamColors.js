/**
 * Shared team colour palette for up to 4 players.
 *
 * A player's colour doubles as their alliance: players who pick the same
 * colour fight side by side, and the match ends when every surviving squad
 * shares one colour. The colour ids travel over the network (lobby roster,
 * gameStart), so they must stay stable — the hex values are display-only.
 */

export const TEAM_COLOR_ORDER = ['red', 'blue', 'green', 'yellow'];

export const TEAM_COLORS = {
    red: '#e74c3c',
    blue: '#3498db',
    green: '#2ecc71',
    yellow: '#f1c40f'
};

export const TEAM_COLOR_LABELS = {
    red: 'Red',
    blue: 'Blue',
    green: 'Green',
    yellow: 'Yellow'
};

export function nextTeamColor(color) {
    const idx = TEAM_COLOR_ORDER.indexOf(color);
    return TEAM_COLOR_ORDER[(idx + 1) % TEAM_COLOR_ORDER.length];
}
