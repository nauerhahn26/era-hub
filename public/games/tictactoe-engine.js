// Pure Tic-tac-toe rules. Row-major squares contain 0 (empty), 1 (X), or 2 (O).
const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function validTicTacToeBoard(board) {
  return Array.isArray(board) && board.length === 9 &&
    Array.from(board).every(value => value === 0 || value === 1 || value === 2);
}

function completedLines(board) {
  if (!validTicTacToeBoard(board)) return [];
  return WINNING_LINES.filter(line => board[line[0]] !== 0 &&
    line.every(square => board[square] === board[line[0]]));
}

export function ticTacToeWinners(board) {
  return [...new Set(completedLines(board).map(line => board[line[0]]))];
}

export function ticTacToeWinner(board) {
  return ticTacToeWinners(board)[0] || 0;
}

export function ticTacToeWinningCells(board) {
  return [...new Set(completedLines(board).flat())];
}

export function placeTicTacToe(board, square, player) {
  if (!validTicTacToeBoard(board) || !Number.isInteger(square) || square < 0 ||
      square > 8 || ![1, 2].includes(player) || board[square] !== 0 || ticTacToeWinner(board)) return null;
  const next = board.slice();
  next[square] = player;
  return next;
}

export function chooseComputerSquare(board) {
  if (!validTicTacToeBoard(board) || ticTacToeWinner(board)) return null;
  const available = [4, 0, 2, 6, 8, 1, 3, 5, 7].filter(square => board[square] === 0);
  for (const player of [2, 1]) {
    for (const square of available) {
      if (ticTacToeWinner(placeTicTacToe(board, square, player)) === player) return square;
    }
  }
  return available[0] ?? null;
}

export function createTicTacToe(mode = 'local') {
  return { board: Array(9).fill(0), turn: 1, mode, status: 'playing', winner: 0,
    pendingComputer: false, history: [] };
}
