// 登録 command「er_triage_add」の参照実装（W48b）。agent は患者の「素の値」だけを add_patients.csv に書き、priority・id・順番は triage_core の規則（addPatient / assignPriority）が出す。
// 入力の header は 9 欄ちょうど: priority・id・arrivalOrder の欄を書く道は無い。全部検査してから書く（途中まで書かない）。data.csv の既存の行も規則で出し直して保存する
#include "triage_core.hpp"

#include <cstdio>
#include <iostream>

namespace {
const char* kHeader = "name,age,symptoms,painLevel,chestPain,breathingTrouble,heavyBleeding,unconsciousOrConfused,severePain";
bool flag(const std::string& s, bool& ok) {
    if (s == "0") return false;
    if (s == "1") return true;
    ok = false;
    return false;
}
}  // namespace

int main() {
    const std::string addFile = "add_patients.csv", dataFile = "data.csv";
    std::ifstream in(addFile);
    if (!in) { std::cerr << "add_patients.csv がありません\n"; return 2; }
    std::string line;
    std::getline(in, line);
    if (line != kHeader) { std::cerr << "add_patients.csv の 1 行目は次の 9 欄の header だけです（priority・id・arrivalOrder の欄は書けません）:\n" << kHeader << "\n"; return 2; }

    std::vector<Patient> add;
    int row = 1;
    while (std::getline(in, line)) {
        ++row;
        if (line.empty()) continue;
        const std::vector<std::string> f = parseCsvLine(line);
        if (f.size() != 9) { std::cerr << "行 " << row << " は 9 欄ではありません（何も書いていません）\n"; return 2; }
        Patient p;
        bool ok = true;
        try {
            p.name = f[0];
            p.age = std::stoi(f[1]);
            p.symptoms = f[2];
            p.painLevel = std::stoi(f[3]);
            p.chestPain = flag(f[4], ok);
            p.breathingTrouble = flag(f[5], ok);
            p.heavyBleeding = flag(f[6], ok);
            p.unconsciousOrConfused = flag(f[7], ok);
            p.severePain = flag(f[8], ok);
        } catch (...) { ok = false; }
        if (!ok || p.name.empty() || p.symptoms.empty() || p.age < 0 || p.age > 120 || p.painLevel < 0 || p.painLevel > 10) {
            std::cerr << "行 " << row << " の値が不正です（name・symptoms は空にできない・age 0〜120・painLevel 0〜10・フラグは 0 か 1。何も書いていません）\n";
            return 2;
        }
        add.push_back(p);
    }
    if (add.empty()) { std::cerr << "足す患者の行がありません\n"; return 2; }

    TriageSystem triage;
    std::string error;
    { std::ifstream probe(dataFile); if (probe) { probe.close(); if (!triage.loadCsv(dataFile, error)) { std::cerr << "data.csv を読めません（" << error << "）。何も書いていません\n"; return 3; } } }
    for (const Patient& p : add) {
        const Patient added = triage.addPatient(p);
        std::cout << "added: " << added.name << " / " << priorityToString(added.priority) << " / id " << added.id << "\n";
    }
    std::vector<int> ids;  // 既存の行も、手で書かれた priority を残さず規則で出し直す
    for (const Patient& p : triage.patients()) ids.push_back(p.id);
    for (int id : ids) { Patient copy = *triage.findById(id); triage.updatePatient(id, copy); }
    if (!triage.saveCsv(dataFile, error)) { std::cerr << error << "\n"; return 3; }
    std::remove(addFile.c_str());
    std::cout << "saved: " << triage.patients().size() << " patients\n";
    return 0;
}
