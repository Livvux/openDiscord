/** This version identifies the policy shown when a person requests a new account. */
export const REGISTRATION_POLICY_VERSION = "2026-10-15";
export const REGISTRATION_HEADER = "x-opendiscord-registration";
export const registrationAttestation = (minimumAge: number) => `${REGISTRATION_POLICY_VERSION}:age-${minimumAge}:terms`;
