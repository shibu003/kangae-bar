// W49 / review27: 「定時で起きた」の印は、その turn だけの物。turn の始めに付け（定時の turn なら付け・人の turn なら外し）、turn の終わりに必ず外す。
// 会話（owner）ごとの印で、人が見ている面に書く前に待つのは「印があり、かつ run が走っている間」だけ。
export const makeSched = (running: (owner: string) => boolean) => {
  const marks = new Set<string>();
  return {
    begin: (owner: string, scheduled: boolean) => { if (scheduled) marks.add(owner); else marks.delete(owner); },
    end: (owner: string) => { marks.delete(owner); },
    is: (owner: string) => marks.has(owner) && running(owner),
  };
};
