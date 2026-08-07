export function currentLeaderboardKey() {
    return `wordle:leaderboard:${new Date().toISOString().slice(0, 7)}`;
}