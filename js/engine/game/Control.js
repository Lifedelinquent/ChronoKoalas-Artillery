/**
 * Control - who is at the controls of the current koala.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

export const Control = {
    /**
     * Does the current turn belong to the LOCAL human player? This is a
     * question about this screen (HUD text, weapon menu, cursor) — the
     * simulation itself never branches on it online, or the clients would
     * stop agreeing.
     */
    isMyTurn() {
        // Online: the squad whose turn it is belongs to our seat
        if (this.net) return this.net.isMyTeam(this.currentTeamIndex);
        // Local game: CPU squads play themselves — returning false here is
        // what locks the human player's input out during a CPU turn. Pure
        // hotseat (no CPU teams) is always "my turn".
        return !this.getCurrentTeam()?.isCPU;
    },

    /**
     * Input source for the current koala: the CPU's virtual pad on a CPU
     * turn, otherwise the InputManager — whose held actions and pointer are
     * fed by the local player, a replay, or (online) the turn owner's
     * command stream. Both expose isHeld(action) and simPointer {x, y, down}.
     */
    getControl() {
        if (this.getCurrentTeam()?.isCPU && this.aiController) return this.aiController.control;
        return this.inputManager;
    }
};
