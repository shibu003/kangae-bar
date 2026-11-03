// app の main.cpp の W48b の差分だけを写した stand-in（実物は GLFW / ImGui で build できない）。実物の差分は docs/verify/w48b/MAIN_CPP_PATCH.md
#include "triage_core.hpp"

#include <iostream>

int main(int argc, char** argv) {
    TriageSystem triage;
    std::string toast;
    // ---- main.cpp の `std::string toast;` の直後に足す差分（ここから）----
    for (int i = 1; i + 1 < argc; ++i) {
        if (std::string(argv[i]) != "--load") continue;
        std::string error;
        if (!triage.loadCsv(argv[i + 1], error)) { toast = error; continue; }
        std::vector<int> ids;  // csv の priority は信じず、規則で出し直す（手で書かれた priority を効かせない）
        for (const Patient& p : triage.patients()) ids.push_back(p.id);
        for (int id : ids) { Patient copy = *triage.findById(id); triage.updatePatient(id, copy); }
    }
    // ---- ここまで ----
    if (!toast.empty()) std::cout << "toast: " << toast << "\n";
    for (const Patient& p : triage.patients()) std::cout << "patient: " << p.name << " / " << priorityToString(p.priority) << "\n";
    std::cout << "waiting: " << triage.patients().size() << "\n";
    return 0;
}
