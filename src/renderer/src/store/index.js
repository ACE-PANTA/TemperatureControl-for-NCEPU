import { defineStore } from 'pinia';

export const useStore = defineStore('useStore',{
  state: () => {
    return{
      token: '',
      user: {
        id: '',
        account:'',
        userName: '',
        position:'',
        imgUrl: ''
      },
      selectedProfessor:{
        id:''
      }
    }
      
    
  },
  getters: {    
    getBasicUrl(){
      return this.basicUrl;
    },
    getToken(state){
        return state.token;
    },
    getUser(state){
        return state.user;
    }
  },
  actions: {
    refreshUser(user){
      this.user=user;
    }
  },
});
