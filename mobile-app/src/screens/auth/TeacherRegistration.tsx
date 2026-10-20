// src/screens/auth/TeacherRegistration.tsx
// Endpoints and payload are unchanged. The server must still enforce every rule (role, college, e-mail uniqueness).

import React, { useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { API_BASE } from "../../services/api";
import {
  cleanAishe,
  cleanPhone,
  cleanText,
  fetchJson,
  isAlreadyRegistered,
  isValidName,
  validatePassword,
} from "../../utils/validation";
import { Banner, Button, Card, Header, ResultView, Screen, Segmented, SectionLabel, SP, T, TextField, font } from "../../components/ui";

type Errs = Partial<Record<"first" | "last" | "phone" | "aishe" | "depts", string>>;

export default function TeacherRegistration({ route }: any) {
  const navigation = useNavigation<any>();
  const { email, password, otp_token } = route?.params || {};

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [aisheCode, setAisheCode] = useState("");
  const [college, setCollege] = useState<any>(null);
  const [courses, setCourses] = useState<any[]>([]);
  const [depts, setDepts] = useState<string[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errs, setErrs] = useState<Errs>({});
  const submitLock = useRef(false);
  const lastRef = useRef<any>(null);
  const phoneRef = useRef<any>(null);

  // route params missing (deep link / state restore): nothing safe to do except go back to login
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

  const clear = (k: keyof Errs) => errs[k] && setErrs((e) => ({ ...e, [k]: undefined }));

  const resetCollege = () => {
    setCollege(null);
    setCourses([]);
    setDepts([]);
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
      if (!c.ok) throw new Error(c.data?.error || "Could not load departments");
      if (!Array.isArray(c.data?.courses) || c.data.courses.length === 0) {
        throw new Error("No departments are set up for this college yet. Contact your institute.");
      }
      setCollege(v.data.college);
      setCourses(c.data.courses);
    } catch (e: any) {
      setErrs((x) => ({ ...x, aishe: e.message || "Verification failed" }));
    } finally {
      setVerifying(false);
    }
  };

  const toggle = (abbr: string) => {
    clear("depts");
    setDepts((p) => (p.includes(abbr) ? p.filter((d) => d !== abbr) : [...p, abbr]));
  };

  const submit = async () => {
    if (submitLock.current) return;
    const first = cleanText(firstName, 50);
    const last = cleanText(lastName, 50);
    const ph = cleanPhone(phone);
    const next: Errs = {};
    if (!isValidName(first)) next.first = "Enter your first name (letters only)";
    if (!isValidName(last)) next.last = "Enter your last name (letters only)";
    if (!ph) next.phone = "Enter a valid mobile number (10 to 13 digits)";
    if (!college) next.aishe = "Verify your institute first";
    else if (depts.length === 0) next.depts = "Select at least one department";
    setErrs(next);
    if (Object.keys(next).length) return;

    const pwErr = validatePassword(password);
    if (pwErr) {
      Alert.alert("Weak password", pwErr, [{ text: "Change password", onPress: () => navigation.goBack() }]);
      return;
    }

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
          role: "teacher",
          teacher: {
            first_name: first,
            last_name: last,
            contact_phone: ph,
            gender,
            aishe_code: college.aishe_code,
            departments: depts,
            designation: "Assistant Professor",
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

      Alert.alert("Registration submitted", "Your account is pending admin approval. You can sign in once it is approved.", [
        { text: "OK", onPress: () => navigation.reset({ index: 0, routes: [{ name: "Auth" }] }) },
      ]);
    } catch (e: any) {
      Alert.alert("Could not register", e.message || "Something went wrong");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <Header title="Teacher registration" subtitle={email} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Banner tone="info" icon="information-circle">
            You register as a Teacher. If you are an HOD, an admin will upgrade your role after approval.
          </Banner>

          <Card>
            <SectionLabel>Personal details</SectionLabel>
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
                onSubmitEditing={() => phoneRef.current?.focus()}
                inputRef={lastRef}
                error={errs.last}
                maxLength={50}
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
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                inputRef={phoneRef}
                error={errs.phone}
                maxLength={16}
              />
              <View>
                <Text style={st.label}>Gender</Text>
                <Segmented
                  options={[
                    { value: "male" as const, label: "Male" },
                    { value: "female" as const, label: "Female" },
                  ]}
                  value={gender}
                  onChange={setGender}
                />
              </View>
            </View>
          </Card>

          <Card>
            <SectionLabel>Institute</SectionLabel>
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
              <Button label="Verify" size="md" onPress={verify} loading={verifying} style={{ marginTop: 0, height: 52 }} />
            </View>

            {college && (
              <View style={st.verified}>
                <Ionicons name="checkmark-circle" size={22} color={T.success} />
                <View style={{ flex: 1 }}>
                  <Text style={font.small}>Verified institute</Text>
                  <Text style={font.h3}>{college.college_name}</Text>
                </View>
              </View>
            )}
          </Card>

          <Card>
            <SectionLabel>Departments</SectionLabel>
            {!college ? (
              <Text style={font.body}>Verify your institute to see its departments.</Text>
            ) : (
              <>
                <Text style={[font.body, { marginBottom: SP.md }]}>Select every department you teach in.</Text>
                <View style={st.deptWrap}>
                  {courses.map((c) => {
                    const on = depts.includes(c.abbr);
                    return (
                      <Pressable
                        key={c.id ?? c.abbr}
                        onPress={() => toggle(c.abbr)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                        style={[st.dept, on && st.deptOn]}
                      >
                        {on && <Ionicons name="checkmark" size={14} color={T.primary} />}
                        <View>
                          <Text style={[st.deptAbbr, on && { color: T.primary }]}>{c.abbr}</Text>
                          <Text style={st.deptName} numberOfLines={1}>
                            {c.course_name}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                {!!errs.depts && <Text style={st.err}>{errs.depts}</Text>}
              </>
            )}
          </Card>

          <Button
            label="Complete registration"
            icon="checkmark-circle-outline"
            onPress={submit}
            loading={submitting}
            disabled={!college || depts.length === 0}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.lg, gap: SP.lg, paddingBottom: 40 },
  label: { fontSize: 12.5, fontWeight: "700", color: T.sub, marginBottom: 7, letterSpacing: 0.2 },
  aisheRow: { flexDirection: "row", gap: SP.sm, alignItems: "flex-start" },
  verified: {
    flexDirection: "row",
    alignItems: "center",
    gap: SP.md,
    marginTop: SP.md,
    padding: SP.md,
    borderRadius: 14,
    backgroundColor: T.successSoft,
  },
  deptWrap: { flexDirection: "row", flexWrap: "wrap", gap: SP.sm },
  dept: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: T.line,
    backgroundColor: T.surface,
    maxWidth: "100%",
  },
  deptOn: { borderColor: T.primary, backgroundColor: T.primarySoft },
  deptAbbr: { fontSize: 14, fontWeight: "800", color: T.ink },
  deptName: { fontSize: 11.5, color: T.sub, maxWidth: 200 },
  err: { color: T.danger, fontSize: 12.5, marginTop: SP.sm, fontWeight: "600" },
});