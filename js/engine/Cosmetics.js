/**
 * Cosmetics - canvas drawing for team customisation: hats, gravestones and
 * the victory-dance pose. Shared by the in-game Renderer and the team
 * editor's live preview.
 *
 * Hats are drawn in the koala sprite's local space (48px sprite centred on
 * the koala, facing right, already mirrored for left-facing koalas): the top
 * of the head sits at about y = -21, centred on x = +2.
 */

const HEAD_X = 2;
const HEAD_TOP = -19;

export function drawHat(ctx, hat, teamColor = '#e74c3c') {
    if (!hat || hat === 'none') return;
    ctx.save();
    ctx.translate(HEAD_X, HEAD_TOP);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';

    switch (hat) {
        case 'tophat':
            ctx.fillStyle = '#1b1b1f';
            ctx.fillRect(-11, -2, 22, 3);          // brim
            ctx.fillRect(-7, -15, 14, 14);         // crown
            ctx.strokeRect(-7, -15, 14, 14);
            ctx.fillStyle = teamColor;
            ctx.fillRect(-7, -5, 14, 3);           // band
            break;
        case 'crown':
            ctx.fillStyle = '#f1c40f';
            ctx.beginPath();
            ctx.moveTo(-9, 1); ctx.lineTo(-9, -8); ctx.lineTo(-5, -3); ctx.lineTo(0, -11);
            ctx.lineTo(5, -3); ctx.lineTo(9, -8); ctx.lineTo(9, 1); ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#e74c3c';
            ctx.beginPath(); ctx.arc(0, -3, 1.6, 0, Math.PI * 2); ctx.fill();
            break;
        case 'helmet':
            ctx.fillStyle = '#556b2f';
            ctx.beginPath();
            ctx.ellipse(0, 0, 13, 10, 0, Math.PI, 0);
            ctx.fill(); ctx.stroke();
            ctx.fillRect(-14, -1, 28, 3);
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.fillRect(-9, -6, 18, 2);
            break;
        case 'party':
            ctx.fillStyle = teamColor;
            ctx.beginPath();
            ctx.moveTo(-7, 1); ctx.lineTo(0, -17); ctx.lineTo(7, 1); ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#fff';
            for (const [x, y] of [[-2, -4], [2, -9], [-1, -12]]) {
                ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
            }
            ctx.fillStyle = '#f1c40f';
            ctx.beginPath(); ctx.arc(0, -17, 2.4, 0, Math.PI * 2); ctx.fill();
            break;
        case 'cowboy':
            ctx.fillStyle = '#8b5a2b';
            ctx.beginPath();
            ctx.ellipse(0, 0, 16, 3.5, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-8, 0); ctx.quadraticCurveTo(-8, -11, 0, -10);
            ctx.quadraticCurveTo(8, -11, 8, 0); ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#3e2a14';
            ctx.fillRect(-8, -3, 16, 2);
            // Corks on strings, naturally
            ctx.strokeStyle = '#3e2a14';
            ctx.beginPath(); ctx.moveTo(-13, 1); ctx.lineTo(-13, 6); ctx.moveTo(13, 1); ctx.lineTo(13, 6); ctx.stroke();
            ctx.fillStyle = '#d2a679';
            ctx.fillRect(-14, 6, 2.5, 3); ctx.fillRect(12, 6, 2.5, 3);
            break;
        case 'beanie':
            ctx.fillStyle = teamColor;
            ctx.beginPath();
            ctx.ellipse(0, 0, 11, 10, 0, Math.PI, 0);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#f5f5f5';
            ctx.fillRect(-11, -2, 22, 4);
            ctx.beginPath(); ctx.arc(0, -11, 3, 0, Math.PI * 2); ctx.fill();
            break;
        case 'chef':
            ctx.fillStyle = '#fbfbfb';
            ctx.fillRect(-8, -6, 16, 7);
            ctx.strokeRect(-8, -6, 16, 7);
            for (const [x, r] of [[-5, 5], [0, 6], [5, 5]]) {
                ctx.beginPath(); ctx.arc(x, -9, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            }
            ctx.fillRect(-8, -8, 16, 4);
            break;
        case 'viking':
            ctx.fillStyle = '#9aa4ad';
            ctx.beginPath();
            ctx.ellipse(0, 0, 11, 10, 0, Math.PI, 0);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#efe6cf';
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.moveTo(s * 9, -3);
                ctx.quadraticCurveTo(s * 18, -6, s * 17, -16);
                ctx.quadraticCurveTo(s * 13, -8, s * 7, -7);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
            }
            ctx.fillStyle = '#6b7079';
            ctx.fillRect(-11, -2, 22, 3);
            break;
        case 'bandana':
            ctx.fillStyle = teamColor;
            ctx.fillRect(-10, 0, 20, 5);
            ctx.strokeRect(-10, 0, 20, 5);
            ctx.beginPath();
            ctx.moveTo(-10, 2); ctx.lineTo(-17, 0); ctx.lineTo(-15, 6); ctx.closePath();
            ctx.fill();
            break;
    }
    ctx.restore();
}

/** Gravestone with its base at (x, y). */
export function drawGrave(ctx, x, y, style = 'cross') {
    ctx.save();
    ctx.fillStyle = '#6b7079';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.47)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    switch (style) {
        case 'stone':
            ctx.moveTo(x - 10, y);
            ctx.lineTo(x - 10, y - 18);
            ctx.arc(x, y - 18, 10, Math.PI, 0);
            ctx.lineTo(x + 10, y);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = 'rgba(20,20,24,0.55)';
            ctx.font = 'bold 7px Outfit, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('RIP', x, y - 14);
            break;
        case 'obelisk':
            ctx.moveTo(x - 6, y);
            ctx.lineTo(x - 4, y - 30);
            ctx.lineTo(x, y - 36);
            ctx.lineTo(x + 4, y - 30);
            ctx.lineTo(x + 6, y);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            break;
        case 'urn':
            ctx.fillStyle = '#9b6a3a';
            ctx.moveTo(x - 6, y);
            ctx.quadraticCurveTo(x - 12, y - 12, x - 5, y - 18);
            ctx.lineTo(x - 6, y - 22);
            ctx.lineTo(x + 6, y - 22);
            ctx.lineTo(x + 5, y - 18);
            ctx.quadraticCurveTo(x + 12, y - 12, x + 6, y);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#6e4826';
            ctx.fillRect(x - 7, y - 24, 14, 3);
            break;
        case 'gumleaf':
            ctx.fillStyle = '#5d8a4e';
            ctx.moveTo(x, y);
            ctx.quadraticCurveTo(x - 13, y - 18, x, y - 34);
            ctx.quadraticCurveTo(x + 13, y - 18, x, y);
            ctx.fill(); ctx.stroke();
            ctx.strokeStyle = 'rgba(30,50,20,0.7)';
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y - 32);
            ctx.stroke();
            break;
        default: // cross
            ctx.roundRect(x - 4, y - 30, 8, 30, 2);
            ctx.roundRect(x - 11, y - 24, 22, 7, 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = 'rgba(20, 20, 24, 0.59)';
            ctx.beginPath();
            ctx.arc(x, y - 21, 1.4, 0, Math.PI * 2);
            ctx.fill();
    }
    ctx.restore();
}

/**
 * Apply a victory-dance pose to the context (already translated to the
 * koala). `t` is seconds into the dance; `seed` desyncs koalas a little.
 */
export function applyDancePose(ctx, dance, t, seed = 0) {
    const p = t * 1.0 + seed * 0.37;
    switch (dance) {
        case 'spin':
            ctx.translate(0, -Math.abs(Math.sin(p * 5)) * 6);
            ctx.scale(Math.cos(p * 7), 1);
            break;
        case 'flip': {
            const cycle = (p * 1.2) % 1;
            const lift = Math.sin(cycle * Math.PI) * 26;
            ctx.translate(0, -lift);
            ctx.rotate(-cycle * Math.PI * 2);
            break;
        }
        case 'wiggle':
            ctx.rotate(Math.sin(p * 16) * 0.28);
            ctx.translate(Math.sin(p * 16) * 2, 0);
            break;
        default: // hop
            ctx.translate(0, -Math.abs(Math.sin(p * 6)) * 16);
            break;
    }
}
