import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  browserSessionPersistence,
  browserLocalPersistence,
  Persistence,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  sendPasswordResetEmail,
  confirmPasswordReset,
  connectAuthEmulator,
  deleteUser,
  OAuthProvider,
  getAuth,
  getRedirectResult,
  signInWithRedirect,
} from "firebase/auth";
import {auth} from 'firebase/auth'

const registerWithEmailAndPassword = async ({ email, password }) => {
  try {
    const userCredential = await auth.createUserWithEmailAndPassword(email, password)
    return userCredential.user
  } catch (error) {
    console.error(`Error registering user: ${error.message}`)
    throw new Error(`Error registering user: ${error.message}`)
  }
}

const loginWithEmailAndPassword = async ({ email, password }) => {
  try {
    const userCredential = await auth.signInWithEmailAndPassword(email, password)
    return userCredential.user
  } catch (error) {
    console.error(`Error logging in user: ${error.message}`)
    throw new Error(`Error logging in user: ${error.message}`)
  }
}

const loginWithSSO = async (provider) => {
  try {
    const providerInstance = new provider()
    const userCredential = await auth.signInWithPopup(providerInstance)
    return userCredential.user
  } catch (error) {
    console.error(`Error logging in user with SSO provider: ${error.message}`)
    throw new Error(`Error logging in user with SSO provider: ${error.message}`)
  }
}

const logout = async () => {
  try {
    await auth.signOut()
  } catch (error) {
    console.error(`Error logging out user: ${error.message}`)
    throw new Error(`Error logging out user: ${error.message}`)
  }
}

const resetPassword = async (email) => {
  try {
    await auth.sendPasswordResetEmail(email)
  } catch (error) {
    console.error(`Error resetting password: ${error.message}`)
    throw new Error(`Error resetting password: ${error.message}`)
  }
}

export default {
  registerWithEmailAndPassword,
  loginWithEmailAndPassword,
  loginWithSSO,
  logout,
  resetPassword,
}
