import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import { saveGame, updateGame } from "./game.repository";
import { buildGamePayload } from "./game.service";
import { validateGameForm } from "./game.validation";

export function validateAndNormalizeGameController(form: any) {
  const validation = validateGameForm(form);

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const result = buildGamePayload(form);

  if (!result.ok || !result.payload) {
    return controllerFailure(result.message);
  }

  return controllerSuccess({ game: result.payload });
}

export function createGameController({
  games,
  form,
}: {
  games: any[];
  form: any;
}) {
  const result = validateAndNormalizeGameController(form);

  if (!result.success || !result.data) {
    return result;
  }

  return controllerSuccess({
    game: result.data.game,
    games: saveGame(games, result.data.game),
  });
}

export function updateGameController({
  games,
  form,
  editingGameIndex,
}: {
  games: any[];
  form: any;
  editingGameIndex: number;
}) {
  const result = validateAndNormalizeGameController(form);

  if (!result.success || !result.data) {
    return result;
  }

  return controllerSuccess({
    game: result.data.game,
    games: updateGame(games, editingGameIndex, result.data.game),
  });
}
