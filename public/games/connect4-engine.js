// Pure Four in a Row rules. Board cells are passive row-major values: 0, 1, 2.
export const emptyConnect4 = () => Array.from({length:6},()=>Array(7).fill(0));
export const validConnect4Board = board => Array.isArray(board) && board.length===6 &&
  Array.from(board).every(row=>Array.isArray(row)&&row.length===7&&Array.from(row).every(n=>n===0||n===1||n===2));

export function connect4Winners(board) {
  if(!validConnect4Board(board))return [];
  const found=new Set();
  for(let r=0;r<6;r++)for(let c=0;c<7;c++)if(board[r][c]) {
    for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
      if(Array.from({length:4},(_,i)=>board[r+i*dr]?.[c+i*dc]).every(n=>n===board[r][c]))found.add(board[r][c]);
    }
  }
  return [...found];
}

export function connect4Winner(board) { return connect4Winners(board)[0]||0; }

export function dropConnect4(board,column,player) {
  if(!validConnect4Board(board)||!Number.isInteger(column)||column<0||column>6||![1,2].includes(player))return null;
  for(let r=5;r>=0;r--)if(!board[r][column]) {
    const result=board.map(row=>row.slice());result[r][column]=player;return result;
  }
  return null;
}

export function chooseComputerColumn(board) {
  if(!validConnect4Board(board))return null;
  const columns=[3,2,4,1,5,0,6].filter(c=>!board[0][c]);
  for(const player of [2,1])for(const c of columns)
    if(connect4Winner(dropConnect4(board,c,player))===player)return c;
  return columns[0]??null;
}

export function createConnect4(mode='local') {
  return {board:emptyConnect4(),turn:1,mode,status:'playing',winner:0,pendingComputer:false,history:[]};
}
