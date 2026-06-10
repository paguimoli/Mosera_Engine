export function listGames(games: any[]) {
  return games;
}

export function findGameById(games: any[], gameId: string) {
  return games.find((game) => game.id === gameId || game.externalId === gameId);
}

export function saveGame(games: any[], game: any) {
  return [...games, game];
}

export function updateGame(games: any[], index: number, game: any) {
  return games.map((createdGame, createdIndex) =>
    createdIndex === index ? game : createdGame
  );
}
