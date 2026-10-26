// Number Tiles movement adapts 2048 by Gabriele Cirulli, copyright 2014.
// MIT licensed: see vendor/2048/LICENSE.txt and vendor/2048/SOURCE.txt.
// Boards use row-major numeric cells. The renderer and input method are separate.
export const DEFAULT_SEED = 0x1a2b3c4d;
export const validTile = n => Number.isSafeInteger(n) && n >= 0 &&
  (n === 0 || Number.isInteger(Math.log2(n)));
export const validTilesBoard = board => Array.isArray(board) && board.length === 4 &&
  Array.from(board).every(row => Array.isArray(row) && row.length === 4 && Array.from(row).every(validTile));

export function nextRandom(seed) {
  let rng = (seed >>> 0) || DEFAULT_SEED;
  rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
  rng >>>= 0;
  return { rng, value: rng / 0x100000000 };
}

export function spawnTile(board, seed) {
  const cells=[];
  for(let row=0;row<4;row++)for(let col=0;col<4;col++)if(!board[row][col])cells.push([row,col]);
  if(!cells.length)return {board:board.map(row=>row.slice()),rng:seed};
  // As upstream: choose the value (90% two), then choose an empty cell.
  const value=nextRandom(seed), cell=nextRandom(value.rng);
  const [row,col]=cells[Math.floor(cell.value*cells.length)];
  const result=board.map(line=>line.slice()); result[row][col]=value.value<0.9?2:4;
  return {board:result,rng:cell.rng};
}

export function createTiles(seed=DEFAULT_SEED) {
  const first=spawnTile(Array.from({length:4},()=>Array(4).fill(0)),seed);
  const second=spawnTile(first.board,first.rng);
  return {...second,score:0,won:false,over:false,history:[]};
}

export function moveTiles(board,direction) {
  if(!validTilesBoard(board) || !['up','down','left','right'].includes(direction))
    return {board:Array.isArray(board)?board.map(row=>Array.isArray(row)?row.slice():row):[],score:0,moved:false};
  const result=board.map(row=>row.slice()); let score=0;
  // Traversal begins at the destination edge. Each source tile is consumed once.
  for(let line=0;line<4;line++) {
    const coordinates=Array.from({length:4},(_,i)=>
      direction==='left'?[line,i]:direction==='right'?[line,3-i]:
        direction==='up'?[i,line]:[3-i,line]);
    const values=coordinates.map(([r,c])=>board[r][c]).filter(Boolean), merged=[];
    for(let i=0;i<values.length;i++) {
      if(values[i]===values[i+1] && Number.isSafeInteger(values[i]*2)) {
        const value=values[i]*2; merged.push(value); score+=value; i++;
      } else merged.push(values[i]);
    }
    coordinates.forEach(([r,c],i)=>{result[r][c]=merged[i]||0;});
  }
  return {board:result,score,moved:result.some((row,r)=>row.some((n,c)=>n!==board[r][c]))};
}

export function tilesCanMove(board) {
  return validTilesBoard(board) && ['up','down','left','right'].some(d=>moveTiles(board,d).moved);
}

