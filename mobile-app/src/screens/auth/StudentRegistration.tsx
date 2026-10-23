// src/screens/auth/StudentRegistration.tsx
// 3 steps: college -> personal -> academic. Endpoint and payload are unchanged.
// The server must still enforce every rule (role, college, e-mail uniqueness, college_name from the AISHE code).

import React, { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { API_BASE } from "../../services/api";
import {
  cleanAishe,
  cleanRoll,
  cleanText,
  fetchJson,
  isAlreadyRegistered,
  isValidName,
  validatePassword,
} from "../../utils/validation";
import { isValidPhone, phoneError, toIntlPhone } from "../../utils/phone";
import { Banner, Button, Card, Header, KeyboardView, ResultView, Screen, SelectField, SP, Steps, T, TextField, font } from "../../components/ui";

const YEARS = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
const SEM_MAP: Record<string, string[]> = {
  "1st Year": ["Sem 1", "Sem 2"],
  "2nd Year": ["Sem 3", "Sem 4"],
  "3rd Year": ["Sem 5", "Sem 6"],
  "4th Year": ["Sem 7", "Sem 8"],
};

const STEPS = [
  { label: "College", icon: "business" as const },
  { label: "You", icon: "person" as const },
  { label: "Academic", icon: "school" as const },
];

type Errs = Partial<Record<"aishe" | "first" | "last" | "roll" | "phone" | "course" | "year" | "sem", string>>;

export default function StudentRegistration({ route }: any) {
  const navigation = useNavigation<any>();
  const { email, password, otp_token } = route?.params || {};

  const [step, setStep] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [aisheCode, setAisheCode] = useState("");
  const [college, setCollege] = useState<any>(null);
  const [courses, setCourses] = useState<any[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [rollNo, setRollNo] = useState("");
  const [phone, setPhone] = useState("");
  const [course, setCourse] = useState("");
  const [year, setYear] = useState("");
  const [semester, setSemester] = useState("");
  const [divisions, setDivisions] = useState<{ division_id: string; name: string }[]>([]);
  const [divisionId, setDivisionId] = useState(""); // optional; "" = decide later in Profile
  const [errs, setErrs] = useState<Errs>({});
  const submitLock = useRef(false);
  const lastRef = useRef<any>(null);
  const rollRef = useRef<any>(null);
  const phoneRef = useRef<any>(null);

  if (!email || !password || !otp_token) {
    return (
      <Screen>
        <ResultView
          icon="alert-circle"
          tone="warning"
          title="Start again"
          message="Your registration session expired. Please begin from the sign-up screen."
          actions={<Button label="Back to login" onPress={() => navigation.reset({ index: 0, routes: [{ name: "Auth" }] })} />}
        />
      </Screen>
    );
  }

  // Divisions are created by the head teacher; load the ones of the chosen course + semester (optional field).
  const courseObj = courses.find((c) => c.course_name === course);
  const courseKey = courseObj ? String(courseObj.id ?? courseObj.course_id ?? "") : "";
  const semNo = Number(String(semester).replace(/\D/g, "")) || 0;
  useEffect(() => {
    setDivisionId("");
    setDivisions([]);
    if (!college || !courseKey || !semNo) return;
    let live = true;
    fetchJson(`${API_BASE}/api/colleges/${encodeURIComponent(college.aishe_code)}/courses/${encodeURIComponent(courseKey)}/divisions?semester=${semNo}`)
      .then((r) => live && r.ok && setDivisions(Array.isArray(r.data?.divisions) ? r.data.divisions : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [college, courseKey, semNo]);

  const clear = (k: keyof Errs) => errs[k] && setErrs((e) => ({ ...e, [k]: undefined }));

  const resetCollege = () => {
    setCollege(null);
    setCourses([]);
    setCourse("");
  };

  const verify = async () => {
    if (verifying) return;
    const code = cleanAishe(aisheCode);
    if (!code) {
      setErrs((e) => ({ ...e, aishe: "Enter a valid AISHE code, for example C-12345" }));
      return;
    }
    setErrs((e) => ({ ...e, aishe: undefined }));
    setVerifying(true);
    resetCollege();
    try {
      const v = await fetchJson(`${API_BASE}/api/colleges/verify/${encodeURIComponent(code)}`);
      if (!v.ok || !v.data?.college) throw new Error(v.data?.error || "College not found");
      const c = await fetchJson(`${API_BASE}/api/colleges/${encodeURIComponent(code)}/courses`);
      if (!c.ok) throw new Error(c.data?.error || "Could not load courses");
      if (!Array.isArray(c.data?.courses) || c.data.courses.length === 0) {
        throw new Error("No courses are set up for this college yet. Contact your institute.");
      }
      setCollege(v.data.college);
      setCourses(c.data.courses);
    } catch (e: any) {
      setErrs((x) => ({ ...x, aishe: e.message || "Verification failed" }));
    } finally {
      setVerifying(false);
    }
  };

  const validateStep = (): boolean => {
    const next: Errs = {};
    if (step === 0) {
      if (!college) next.aishe = "Verify your college to continue";
    } else if (step === 1) {
      if (!isValidName(cleanText(firstName, 50))) next.first = "Enter your first name (letters only)";
      if (!isValidName(cleanText(lastName, 50))) next.last = "Enter your last name (letters only)";
      if (cleanRoll(rollNo).length < 2) next.roll = "Enter your roll number / PRN";
      if (!toIntlPhone(phone)) next.phone = phoneError(phone) || "Enter a valid mobile number";
    } else {
      if (!course) next.course = "Select your course";
      if (!year) next.year = "Select your year";
      if (!semester) next.sem = "Select your semester";
    }
    setErrs(next);
    return Object.keys(next).length === 0;
  };

  const onNext = () => {
    if (validateStep()) setStep((s) => s + 1);
  };

  const onBack = () => {
    if (step > 0) setStep((s) => s - 1);
    else navigation.goBack();
  };

  const finish = async () => {
    if (submitLock.current || !validateStep()) return;

    const pwErr = validatePassword(password);
    if (pwErr) {
      Alert.alert("Weak password", pwErr, [{ text: "Change password", onPress: () => navigation.goBack() }]);
      return;
    }
    const ph = toIntlPhone(phone);
    if (!college || !ph) return;

    submitLock.current = true;
    setSubmitting(true);
    try {
      const res = await fetchJson(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          otp_token,
          role: "student",
          student: {
            first_name: cleanText(firstName, 50),
            last_name: cleanText(lastName, 50),
            roll_no: cleanRoll(rollNo),
            phone: ph,
            aishe_code: college.aishe_code,
            college_name: college.college_name,
            course_name: course,
            degree: courses.find((c) => c.course_name === course)?.abbr, // server looks the course up by abbr
            semester,
            year,
            division_id: divisionId || undefined,
          },
        }),
      });

      if (!res.ok) {
        if (isAlreadyRegistered(res)) {
          Alert.alert("Already registered", "An account with this email already exists. Please log in instead.", [
            { text: "Go to login", onPress: () => navigation.reset({ index: 0, routes: [{ name: "Auth" }] }) },
          ]);
          return;
        }
        if (res.status === 403 && /verif/i.test(String(res.data?.error))) {
          Alert.alert("Verify your email again", res.data?.error, [{ text: "OK", onPress: () => navigation.goBack() }]);
          return;
        }
        throw new Error(res.data?.error || "Registration failed. Please try again.");
      }

      Alert.alert("Registration complete", "Your account is pending approval by your institute. You can log in once it is approved.", [
        { text: "OK", onPress: () => navigation.reset({ index: 0, routes: [{ name: "Auth" }] }) },
      ]);
    } catch (e: any) {
      Alert.alert("Could not register", e.message || "Something went wrong");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const titles = ["Find your college", "Personal details", "Academic info"];

  return (
    <Screen>
      <Header title="Student registration" subtitle={email} onBack={onBack} />
      <KeyboardView>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Steps steps={STEPS} current={step} />

          <Card>
            <Text style={[font.h2, { marginBottom: SP.lg }]}>{titles[step]}</Text>

            {step === 0 && (
              <View style={{ gap: SP.md }}>
                <View style={st.aisheRow}>
                  <View style={{ flex: 1 }}>
                    <TextField
                      value={aisheCode}
                      onChangeText={(t) => {
                        setAisheCode(t);
                        clear("aishe");
                        if (college) resetCollege(); // editing the code invalidates the earlier verification
                      }}
                      placeholder="AISHE code, e.g. C-12345"
                      icon="business-outline"
                      autoCapitalize="characters"
                      returnKeyType="go"
                      onSubmitEditing={verify}
                      error={errs.aishe}
                      maxLength={20}
                    />
                  </View>
                  <Button label="Verify" size="md" onPress={verify} loading={verifying} style={{ height: 52 }} />
                </View>
                {college && (
                  <View style={st.verified}>
                    <Ionicons name="checkmark-circle" size={22} color={T.success} />
                    <View style={{ flex: 1 }}>
                      <Text style={font.small}>Verified college</Text>
                      <Text style={font.h3}>{college.college_name}</Text>
                    </View>
                  </View>
                )}
              </View>
            )}

            {step === 1 && (
              <View style={{ gap: SP.lg }}>
                <TextField
                  label="First name"
                  icon="person-outline"
                  value={firstName}
                  onChangeText={(t) => {
                    setFirstName(t);
                    clear("first");
                  }}
                  placeholder="First name"
                  autoCapitalize="words"
                  autoComplete="given-name"
                  textContentType="givenName"
                  returnKeyType="next"
                  onSubmitEditing={() => lastRef.current?.focus()}
                  error={errs.first}
                  maxLength={50}
                />
                <TextField
                  label="Last name"
                  icon="person-outline"
                  value={lastName}
                  onChangeText={(t) => {
                    setLastName(t);
                    clear("last");
                  }}
                  placeholder="Last name"
                  autoCapitalize="words"
                  autoComplete="family-name"
                  textContentType="familyName"
                  returnKeyType="next"
                  onSubmitEditing={() => rollRef.current?.focus()}
                  inputRef={lastRef}
                  error={errs.last}
                  maxLength={50}
                />
                <TextField
                  label="Roll number / PRN"
                  icon="id-card-outline"
                  value={rollNo}
                  onChangeText={(t) => {
                    setRollNo(t);
                    clear("roll");
                  }}
                  placeholder="Roll number"
                  autoCapitalize="characters"
                  returnKeyType="next"
                  onSubmitEditing={() => phoneRef.current?.focus()}
                  inputRef={rollRef}
                  error={errs.roll}
                  maxLength={30}
                />
                <TextField
                  label="Mobile number"
                  icon="call-outline"
                  value={phone}
                  onChangeText={(t) => {
                    setPhone(t);
                    clear("phone");
                  }}
                  placeholder="10 digit mobile number"
                  phone
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  inputRef={phoneRef}
                  error={errs.phone}
                  helper={!errs.phone && phone.length > 0 && !isValidPhone(phone) ? `${phone.length}/10 digits` : undefined}
                />
              </View>
            )}

            {step === 2 && (
              <View style={{ gap: SP.lg }}>
                <SelectField
                  label="Course"
                  icon="book-outline"
                  title="Select course"
                  value={course}
                  placeholder="Select course"
                  options={courses.map((c) => ({ value: c.course_name, label: c.course_name, sub: c.abbr }))}
                  onChange={(v) => {
                    setCourse(v);
                    clear("course");
                  }}
                  error={errs.course}
                />
                <SelectField
                  label="Year"
                  icon="calendar-outline"
                  title="Select year"
                  value={year}
                  placeholder="Select year"
                  options={YEARS.map((y) => ({ value: y, label: y }))}
                  onChange={(v) => {
                    setYear(v);
                    setSemester(""); // semester depends on the year
                    clear("year");
                  }}
                  error={errs.year}
                />
                <SelectField
                  label="Semester"
                  icon="layers-outline"
                  title="Select semester"
                  value={semester}
                  placeholder={year ? "Select semester" : "Select year first"}
                  disabled={!year}
                  options={(SEM_MAP[year] || []).map((x) => ({ value: x, label: x }))}
                  onChange={(v) => {
                    setSemester(v);
                    clear("sem");
                  }}
                  error={errs.sem}
                />
                {divisions.length > 0 && (
                  <SelectField
                    label="Division (optional)"
                    icon="people-outline"
                    title="Select division"
                    value={divisionId}
                    placeholder="Select your division"
                    options={divisions.map((d) => ({ value: d.division_id, label: `Division ${d.name}` }))}
                    onChange={(v) => setDivisionId(v)}
                  />
                )}
                <Banner tone="info" icon="shield-checkmark">
                  Your attendance is verified against your college network and location, so enter details exactly as your institute has them.
                </Banner>
              </View>
            )}
          </Card>

          <View style={st.nav}>
            {step < 2 ? (
              <Button label="Next" icon="arrow-forward" onPress={onNext} />
            ) : (
              <Button label="Finish registration" icon="checkmark-circle-outline" onPress={finish} loading={submitting} />
            )}
          </View>
        </ScrollView>
      </KeyboardView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.lg, gap: SP.lg, paddingBottom: 40 },
  aisheRow: { flexDirection: "row", gap: SP.sm, alignItems: "flex-start" },
  verified: {
    flexDirection: "row",
    alignItems: "center",
    gap: SP.md,
    padding: SP.md,
    borderRadius: 14,
    backgroundColor: T.successSoft,
  },
  nav: { marginTop: SP.sm },
});