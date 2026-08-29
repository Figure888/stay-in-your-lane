// Convoy multiplayer — thin wrapper over the Postgres functions.
//
// All the game logic lives in the database (db/convoy_0*.sql). This file
// only forwards calls. Same admin-client pattern as lib/referrals.js.

import { admin } from './referrals.js';

function unwrap(result, label) {
  if (result.error) {
    console.error(`${label} failed`, result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}

/** Join the queue at a stake, or return the game you're already in. */
export async function joinConvoy(userId, stake) {
  return unwrap(
    await admin.rpc('convoy_join', { p_user: userId, p_stake: stake }),
    'convoy_join'
  );
}

/** The board as this player is allowed to see it. Never exposes the pile
 *  order or the opponent's held cards. */
export async function convoyState(gameId, userId) {
  return unwrap(
    await admin.rpc('convoy_state', { p_game: gameId, p_user: userId }),
    'convoy_state'
  );
}

export async function convoyDraw(gameId, userId) {
  return unwrap(
    await admin.rpc('convoy_draw', { p_game: gameId, p_user: userId }),
    'convoy_draw'
  );
}

export async function convoyPlace(gameId, userId, lane) {
  return unwrap(
    await admin.rpc('convoy_place', { p_game: gameId, p_user: userId, p_lane: lane }),
    'convoy_place'
  );
}

export async function convoySwap(gameId, userId, slot) {
  return unwrap(
    await admin.rpc('convoy_swap', { p_game: gameId, p_user: userId, p_slot: slot }),
    'convoy_swap'
  );
}

export async function convoyBet(gameId, userId, action) {
  return unwrap(
    await admin.rpc('convoy_bet', { p_game: gameId, p_user: userId, p_action: action }),
    'convoy_bet'
  );
}
