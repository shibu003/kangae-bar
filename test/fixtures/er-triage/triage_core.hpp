#pragma once

#include <algorithm>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

enum class Priority {
    Low = 1,
    Medium = 2,
    High = 3
};

struct Patient {
    int id{};
    std::string name;
    int age{};
    std::string symptoms;
    int painLevel{};
    bool chestPain{};
    bool breathingTrouble{};
    bool heavyBleeding{};
    bool unconsciousOrConfused{};
    bool severePain{};
    Priority priority{Priority::Low};
    int arrivalOrder{};
};

inline const char* priorityToString(Priority priority) {
    switch (priority) {
        case Priority::High: return "High";
        case Priority::Medium: return "Medium";
        case Priority::Low: return "Low";
    }
    return "Low";
}

inline Priority priorityFromString(const std::string& value) {
    if (value == "High") return Priority::High;
    if (value == "Medium") return Priority::Medium;
    return Priority::Low;
}

inline Priority assignPriority(const Patient& patient) {
    // Preserves the decision logic from the original console project.
    if (patient.unconsciousOrConfused || patient.breathingTrouble || patient.chestPain ||
        patient.heavyBleeding || patient.painLevel >= 9) {
        return Priority::High;
    }

    if (patient.severePain || patient.painLevel >= 6 || patient.age < 2 || patient.age >= 75) {
        return Priority::Medium;
    }

    return Priority::Low;
}

inline bool patientComesFirst(const Patient& left, const Patient& right) {
    if (left.priority != right.priority) {
        return static_cast<int>(left.priority) > static_cast<int>(right.priority);
    }
    return left.arrivalOrder < right.arrivalOrder;
}

inline std::string csvEscape(const std::string& value) {
    const bool mustQuote = value.find_first_of(",\"\n") != std::string::npos;
    std::string escaped;
    escaped.reserve(value.size() + 8);

    for (char ch : value) {
        if (ch == '"') escaped += '"';
        escaped += ch;
    }

    return mustQuote ? "\"" + escaped + "\"" : escaped;
}

inline std::vector<std::string> parseCsvLine(const std::string& line) {
    std::vector<std::string> fields;
    std::string current;
    bool inQuotes = false;

    for (std::size_t index = 0; index < line.size(); ++index) {
        const char ch = line[index];
        if (inQuotes) {
            if (ch == '"' && index + 1 < line.size() && line[index + 1] == '"') {
                current += '"';
                ++index;
            } else if (ch == '"') {
                inQuotes = false;
            } else {
                current += ch;
            }
        } else if (ch == '"') {
            inQuotes = true;
        } else if (ch == ',') {
            fields.push_back(current);
            current.clear();
        } else {
            current += ch;
        }
    }

    fields.push_back(current);
    return fields;
}

class TriageSystem {
public:
    const std::vector<Patient>& patients() const { return patients_; }
    std::vector<Patient>& patients() { return patients_; }

    Patient addPatient(Patient patient) {
        patient.id = nextId_++;
        patient.arrivalOrder = nextArrivalOrder_++;
        patient.priority = assignPriority(patient);
        patients_.push_back(patient);
        sortPatients();
        return patient;
    }

    bool updatePatient(int id, const Patient& replacement) {
        auto it = std::find_if(patients_.begin(), patients_.end(),
                               [id](const Patient& patient) { return patient.id == id; });
        if (it == patients_.end()) return false;

        const int arrival = it->arrivalOrder;
        *it = replacement;
        it->id = id;
        it->arrivalOrder = arrival;
        it->priority = assignPriority(*it);
        sortPatients();
        return true;
    }

    bool treatNext(Patient* treated = nullptr) {
        if (patients_.empty()) return false;
        if (treated) *treated = patients_.front();
        patients_.erase(patients_.begin());
        return true;
    }

    Patient* findById(int id) {
        auto it = std::find_if(patients_.begin(), patients_.end(),
                               [id](const Patient& patient) { return patient.id == id; });
        return it == patients_.end() ? nullptr : &(*it);
    }

    int count(Priority priority) const {
        return static_cast<int>(std::count_if(
            patients_.begin(), patients_.end(),
            [priority](const Patient& patient) { return patient.priority == priority; }));
    }

    bool saveCsv(const std::string& filename, std::string& error) const {
        std::ofstream output(filename);
        if (!output) {
            error = "Could not open the selected file for saving.";
            return false;
        }

        output << "id,name,age,symptoms,painLevel,chestPain,breathingTrouble,heavyBleeding,"
                  "unconsciousOrConfused,severePain,priority,arrivalOrder\n";

        for (const Patient& patient : patients_) {
            output << patient.id << ','
                   << csvEscape(patient.name) << ','
                   << patient.age << ','
                   << csvEscape(patient.symptoms) << ','
                   << patient.painLevel << ','
                   << patient.chestPain << ','
                   << patient.breathingTrouble << ','
                   << patient.heavyBleeding << ','
                   << patient.unconsciousOrConfused << ','
                   << patient.severePain << ','
                   << priorityToString(patient.priority) << ','
                   << patient.arrivalOrder << '\n';
        }

        if (!output) {
            error = "An error occurred while writing the CSV file.";
            return false;
        }

        return true;
    }

    bool loadCsv(const std::string& filename, std::string& error) {
        std::ifstream input(filename);
        if (!input) {
            error = "Could not open the selected CSV file.";
            return false;
        }

        std::vector<Patient> loaded;
        std::string line;
        std::getline(input, line); // header
        int maxId = 0;
        int maxArrival = 0;
        int lineNumber = 1;

        while (std::getline(input, line)) {
            ++lineNumber;
            if (line.empty()) continue;
            const std::vector<std::string> fields = parseCsvLine(line);
            if (fields.size() != 12) {
                error = "CSV row " + std::to_string(lineNumber) + " does not have 12 fields.";
                return false;
            }

            Patient patient;
            try {
                patient.id = std::stoi(fields[0]);
                patient.name = fields[1];
                patient.age = std::stoi(fields[2]);
                patient.symptoms = fields[3];
                patient.painLevel = std::stoi(fields[4]);
                patient.chestPain = std::stoi(fields[5]) != 0;
                patient.breathingTrouble = std::stoi(fields[6]) != 0;
                patient.heavyBleeding = std::stoi(fields[7]) != 0;
                patient.unconsciousOrConfused = std::stoi(fields[8]) != 0;
                patient.severePain = std::stoi(fields[9]) != 0;
                patient.priority = priorityFromString(fields[10]);
                patient.arrivalOrder = std::stoi(fields[11]);
            } catch (...) {
                error = "CSV row " + std::to_string(lineNumber) + " contains invalid values.";
                return false;
            }

            loaded.push_back(patient);
            maxId = std::max(maxId, patient.id);
            maxArrival = std::max(maxArrival, patient.arrivalOrder);
        }

        patients_ = std::move(loaded);
        nextId_ = maxId + 1;
        nextArrivalOrder_ = maxArrival + 1;
        sortPatients();
        return true;
    }

private:
    void sortPatients() {
        std::stable_sort(patients_.begin(), patients_.end(), patientComesFirst);
    }

    std::vector<Patient> patients_;
    int nextId_{1};
    int nextArrivalOrder_{1};
};
