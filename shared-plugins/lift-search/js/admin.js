(function($) {
  "use strict";
  var liftAdmin = liftAdmin || {};

  liftAdmin.App = Backbone.Router.extend({
    el: '#lift-status-page',
    initialize: function() {
      Backbone.emulateHTTP = true;
      Backbone.emulateJSON = true;

      this.settings = new liftAdmin.SettingsCollection();
      this.domains = new liftAdmin.DomainsCollection();

      this.on('resetLift', this.render, this)
          .on('unsetDomainName', this.render, this);
      this.settings.on('sync reset', function() {
        var credentials = this.settings.getValue('credentials');
        this.domains.settings = this.settings;
        if ('' === credentials.accessKey && '' === credentials.secretKey) {
          this.domains.disablePolling();
        } else {
          this.domains.enablePolling();
        }
        this.render();
      }, this)
          .fetch();

      this.domains.on('sync_error', this.handleDomainSyncError, this);

    },
    render: function() {
      var state = this.getState();
      if (state) {
        this.renderState(state);
      }
      return this;
    },
    getState: function() {
      var _this = this,
          errorModal,
          state,
          domainname,
          domain,
          credentials;

      credentials = this.settings.getValue('credentials');
      if (!(credentials.accessKey && credentials.secretKey)) {
        state = 'set_credentials';
      } else {
        if (typeof this.domains.deferred === 'object' && 'then' in this.domains.deferred) {
          //rerender after domains have completely loaded
          $.when(this.domains.deferred).then(function() {
            _this.render();
          });
        } else {
          domainname = this.settings.getValue('domainname');
          domain = domainname && this.domains.get(domainname);
          if (!domainname) {
            state = 'set_domainname';
          } else if ( domain && ( domain.get('Processing') || domain.get('RequiresIndexDocuments') ) ) {
            state = 'processing_setup';
          } else {
            if (!domain) {
              errorModal = new liftAdmin.ModalMissingDomain({model: {settings: this.settings, domains: this.domains}});
              this.openModal(errorModal);
            }
            state = 'dashboard';
          }
        }
      }

      return state;
    },
    renderState: function(state) {
      var new_view,
          state_views;

      state_views = {
        set_credentials: {view: liftAdmin.SetCredentialsView, args: {model: {settings: this.settings}}},
        set_domainname: {view: liftAdmin.SetDomainView, args: {model: {settings: this.settings, domains: this.domains}}},
        processing_setup: {view: liftAdmin.SetupProcessingView, args: {model: {settings: this.settings, domains: this.domains}}},
        dashboard: {view: liftAdmin.DashboardView, args: {model: {settings: this.settings, domains: this.domains}}}
      };

      new_view = state_views[state];

      // only process if setting a new view
      if (this.currentView && (this.currentView instanceof new_view.view)) {
        return;
      }
      // clean up the old view
      if (this.currentView) {
        this.currentView.close();
      }

      this.currentView = new new_view.view(new_view.args);

      this.currentView.setElement($('<div></div>').appendTo(this.el));
      this.currentView.render();
      return this;
    },
    handleDomainSyncError: function(unused, error) {
      var modal;
      if (error.code === 'invalidCredentials') {
        modal = new liftAdmin.ModalErrorSetCredentialsView({model: {settings: this.settings}});
      } else {
        modal = new liftAdmin.ModalError({model: {settings: this.settings, domains: this.domains, error: error}});
      }

      if (modal) {
        this.openModal(modal);
      }
      return this;
    },
    openModal: function(view) {
      var $el = $('<div></div>');
      if (this.currentModal) {
        this.closeModal(this.currentModal);
      }
      $('#modal_content').append($el);
      view.setElement($el);
      view.render();
      $('#lift_modal').show();
      this.currentModal = view;
      return this;
    },
    closeModal: function(view) {
      view.close();
      $('#modal_content').html('');
      $('#lift_modal').hide();
      delete this.currentModal;
      return this;
    },
    resetLift: function(options) {
      var success,
          silent;

      options = options ? _.clone(options) : {};
      success = options.success;
      silent = options.silent;
      options.silent = true;
      options.success = function(object, options) {
        var _this = object,
            success;
        options = options ? _.clone(options) : {};
        options.success = function() {
          if (success) {
            success(_this, options);
          }
          if (!silent) {
            _this.trigger('resetLift', _this, options);
          }
        };
        _this.settings.get('credentials').save({value: {accessKey: '', secretKey: ''}}, options);
        _this.domains.disablePolling();
        return this;
      };
      this.unsetDomainName(options);
    },
    unsetDomainName: function(options) {
      var _this = this,
          success;
      options = options ? _.clone(options) : {};
      success = options.success;
      options.success = function() {
        if (success) {
          success(_this, options);
        }
        if (!options.silent) {
          _this.trigger('unsetDomainName', _this, options);
        }
      };
      this.settings.get('domainname').save({value: ''}, options);
      return this;
    }
  });

  liftAdmin.templateLoader = {
    templates: {},
    getTemplate: function(name) {
      if( !this.templates[name] && $('script#' + name + '-template').is('*') )
        this.templates[name] = $('script#' + name + '-template').html();
      return this.templates[name] || false;
    }
  };

  liftAdmin.SettingModel = Backbone.Model.extend({
    url: function() {
      return window.ajaxurl + '?action=lift_setting&setting=' + this.get('id') + '&nonce=' + this.collection.getValue('nonce');
    },
    parse: function(res) {
      //if came from collection
      if (res.id) {
        return res;
      }
      return res.data || null;
    }
  });

  liftAdmin.SettingsCollection = Backbone.Collection.extend({
    model: liftAdmin.SettingModel,
    url: function() {
      return window.ajaxurl + '?action=lift_settings';
    },
    getValue: function(id) {
      return this.get(id) && this.get(id).get('value');
    },
    setValue: function(id, value) {
      return this.get(id) && this.get(id).set('value', value);
    },
    toJSONObject: function() {
      return _.object(this.map(function(model) {
        return [model.get('id'), model.get('value')];
      }));
    }
  });

  liftAdmin.UpdateQueue = Backbone.Collection.extend({
    initialize: function() {
      this.meta = {page: 1};
      this.disablePolling();
    },
    enablePolling: function() {
      if (!this.pollingEnabled) {
        this.fetchWithDeferred();
      }
      this.pollingEnabled = true;
      return this;
    },
    disablePolling: function() {
      if (this.pollingEnabled) {
        clearTimeout(this.pollingTimeout);
      }
      this.pollingEnabled = false;
      return this;
    },
    fetchWithDeferred: function() {
      var _this = this,
          intervalUpdate = function() {
        _this.fetchWithDeferred();
      };

      this.deferred = this.fetch()
          .always(function() {
        delete _this.deferred;
        if (_this.pollingEnabled) {
          _this.pollingTimeout = setTimeout(intervalUpdate, 60000);
        }
        if (_this.error && _this.pollingEnabled) {
          _this.trigger('sync_error', this, _this.error);
        }

      });
      return this.deferred;
    },
    url: function() {
      return window.ajaxurl + '?action=lift_update_queue&paged=' + this.meta.page;
    },
    fetchPage: function(page) {
      this.meta.page = page;
      return this.fetch();
    },
    parse: function(resp) {
      this.meta.page = resp.current_page;
      this.meta.per_page = resp.per_page;
      this.meta.found_rows = resp.found_rows;
      this.meta.total_pages = Math.ceil(resp.found_rows / resp.per_page);
      return resp.updates;
    },
    getMeta: function(name) {
      return this.meta[name];
    }
  });

  liftAdmin.UpdateQueueView = Backbone.View.extend({
    _template: 'update-queue',
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate(this._template));
      this.collection = new liftAdmin.UpdateQueue();
      this.collection.on('sync', this.render, this).enablePolling();
    },
    events: {
      'click a.page-numbers': 'onClickGoToPage'
    },
    render: function() {
      var _this = this;
      if (typeof this.collection.deferred === 'object' && 'then' in this.collection.deferred) {
        //rerender after domains have completely loaded
        $.when(this.collection.deferred).then(function() {
          _this.render();
          return;
        });
      }
      $(this.el).html(this.template({updates: this.collection.toJSON(), meta: this.collection.meta}));
      $('#lift_queue_nav').liftPaginator({
        totalPages: this.collection.getMeta('total_pages'),
        currentPage: this.collection.getMeta('page')
      });
      return this;
    },
    onClickGoToPage: function(e) {
      var page = $(e.target).attr('href').replace(/\D/g, '');
      e.preventDefault();
      this.goToPage(page);
    },
    goToPage: function(page) {
      this.collection.fetchPage(page);
    }
  });

  liftAdmin.ErrorLog = Backbone.Collection.extend({
    initialize: function() {
      this.meta = {};
      this.disablePolling();
    },
    enablePolling: function() {
      if (!this.pollingEnabled) {
        this.fetchWithDeferred();
      }
      this.pollingEnabled = true;
      return this;
    },
    disablePolling: function() {
      if(this.pollingEnabled) {
        clearTimeout(this.pollingTimeout);
      }
      this.pollingEnabled = false;
      return this;
    },
    fetchWithDeferred: function() {
      var _this = this,
          intervalUpdate = function() {
        _this.fetchWithDeferred();
      };

      this.deferred = this.fetch()
          .always(function() {
        delete _this.deferred;
        if (_this.pollingEnabled) {
          _this.pollingTimeout = setTimeout(intervalUpdate, 60000);
        }
        if (_this.error && _this.pollingEnabled) {
          _this.trigger('sync_error', this, _this.error);
        }

      });
      return this.deferred;
    },
    url: function() {
      return window.ajaxurl + '?action=lift_error_log&nonce=' + this.meta.nonce;
    },
    parse: function(resp) {
      this.meta.nonce = resp.meta;
      this.meta.view_all_url = resp.view_all_url;
      return resp.errors;
    }
  });

  liftAdmin.ErrorLogView = Backbone.View.extend({
    _template: 'error-logs',
    initialize: function() {
      this.isCollectionSynced = false;
      this.template = _.template(liftAdmin.templateLoader.getTemplate(this._template));
      this.collection = new liftAdmin.ErrorLog();
      this.collection.on('all', this.render, this).enablePolling();
    },
    events: {
      'click #error_logs_clear': 'onClickClearLogs'
    },
    render: function() {
      var _this = this;
      if (typeof this.collection.deferred === 'object' && 'then' in this.collection.deferred) {
        //rerender after domains have completely loaded
        $.when(this.collection.deferred).then(function() {
          _this.render();
          return;
        });
      }
      $(this.el).html(this.template({errors: this.collection.toJSON(), meta: this.collection.meta}));
      return this;
    },
    onClickClearLogs: function(e) {
      e.preventDefault();
      this.collection.fetch({type: 'POST'});
    }
  });

  liftAdmin.DashboardView = Backbone.View.extend({
    initialize: function() {
      this.updateView = new liftAdmin.UpdateQueueView({el: $('#document_queue')});
      if (window.liftData.errorLoggingEnabled) {
        this.errorView = new liftAdmin.ErrorLogView({el: $('#error_log')});
      }
      this.template = _.template(liftAdmin.templateLoader.getTemplate('dashboard'));
      this.model.domains.on('reset', this.render, this);
      this.model.settings.on('reset', this.render, this);
    },
    onClose: function() {
      this.model.domains.off('reset', this.render, this);
    },
    events: {
      'click #batch_interval_update': 'updateBatchInterval',
      'click #batch_sync_now': 'setSyncNow',
      'click #lift_reset': 'resetLift',
      'click #override_search': 'setOverrideSearch',
      'click #lift_update_keys': 'updateKeys'
    },
    render: function() {
      this.el.innerHTML = this.template({settings: this.model.settings.toJSONObject(), domain: this.model.domains.toJSON()});
      $('#batch_interval_unit').val(this.model.settings.getValue('batch_interval').unit);
      this.updateView.setElement($('#document_queue')).render();
      if(this.errorView) {
        this.errorView.setElement($('#error_log')).render();
      }
      return this;
    },
    updateBatchInterval: function() {
      var _this = this,
          batchInterval = {
        value: $('#batch_interval').val(),
        unit: $('#batch_interval_unit').val()
      };
      this.beforeSave();
      this.model.settings.get('batch_interval')
          .save({value: batchInterval}, {
      }).always(function() {
        _this.afterSave();
      });
      return this;
    },
    setSyncNow: function() {
      var _this = this;
      this.beforeSave();
      this.model.settings.get('next_sync')
          .save({value: Math.round(new Date().getTime() / 1000)}, {
      }).always(function() {
        _this.model.settings.fetch();
        _this.afterSave();
      });
      return this;
    },
    setOverrideSearch: function(e) {
      var _this = this;
      this.beforeSave();
      this.model.settings.get('override_search')
          .save({value: e.target.checked}, {
      }).always(function() {
        _this.afterSave();
      });
      return this;
    },
    updateKeys: function() {
      var modal = new liftAdmin.ModalSetCredentialsView({model: {settings: this.model.settings}});
      adminApp.openModal(modal);
      return this;
    },
    beforeSave: function() {
      $(this.el).find('input').attr('disabled', true);
      return this;
    },
    afterSave: function() {
      $(this.el).find('input').attr('disabled', false);
      return this;
    },
    resetLift: function() {
      adminApp.resetLift();
      return this;
    }
  });


  liftAdmin.DomainModel = Backbone.Model.extend({
    url: function() {
      return window.ajaxurl + '?action=lift_domain&nonce=' + this.getNonce();
    },
    idAttribute: 'DomainName',
    getNonce: function() {
      return (this.collection && this.collection.nonce) || this.nonce;
    }
  });

  liftAdmin.DomainsCollection = Backbone.Collection.extend({
    model: liftAdmin.DomainModel,
    initialize: function() {
      this.disablePolling();
    },
    enablePolling: function() {
      if(!this.pollingEnabled) {
        this.fetchWithDeferred();
      }
      this.pollingEnabled = true;
      return this;
    },
    disablePolling: function() {
      if(this.pollingEnabled) {
        clearTimeout(this.pollingTimeout);
      }
      this.pollingEnabled = false;
      return this;
    },
    fetchWithDeferred: function() {
      var _this = this,
          intervalUpdate = function() {
        _this.fetchWithDeferred();
      };

      var region = this.settings.get('region').get('value');
      this.deferred = this.fetch({data: {region: region}})
          .always(function() {
        delete _this.deferred;
        if (_this.pollingEnabled) {
          _this.pollingTimeout = setTimeout(intervalUpdate, 60000);
        }
        if (_this.error && _this.pollingEnabled) {
          _this.trigger('sync_error', this, _this.error);
        }
      });
      return this.deferred;
    },
    url: function() {
      return window.ajaxurl + '?action=lift_domains';
    },
    parse: function(resp) {
      this.nonce = resp.nonce;
      this.error = resp.error;
      return resp.domains;
    }
  });

  Backbone.View.prototype.close = function() {
    this.remove();
    this.unbind();
    this.undelegateEvents();
    if (this.onClose) {
      this.onClose();
    }
  };

  liftAdmin.SetCredentialsView = Backbone.View.extend({
    _template: 'set-credentials',
    loadText: $('<p id="lift-load-text">'),
    loader: $('<p id="lift-ajax-loader">'),
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate(this._template));
      this.model.settings.get('credentials').on('error', this.onSaveError, this);
      this.model.settings.get('credentials').on('sync', this.onSaveSuccess, this);
    },
    onClose: function() {
      this.model.settings.get('credentials').off('error', this.onSaveError, this);
      this.model.settings.get('credentials').off('sync', this.onSaveSuccess, this);
    },
    events: {
      'click #save_credentials': 'updateCredentials'
    },
    render: function() {
      this.el.innerHTML = this.template(this.model.settings.toJSONObject());
      $('#save_credentials').after(this.loader);
      return this;
    },
    ajaxLoader: function( text ) {
      this.loadText.text(text);
      this.loader.html(this.loadText);
      this.loader.show();
    },
    beforeSave: function() {
      $('#errors').hide();
      $('#save_credentials').attr('disabled', 'disabled');
      this.ajaxLoader('Authenticating with Amazon');
    },
    updateCredentials: function() {
      var _this = this,
          credentials = {
        accessKey: $('#accessKey').val(),
        secretKey: $('#secretKey').val()
      };
      this.beforeSave();
      this.model.settings.get('credentials').save({value: credentials}, {
      });
    },
    onSaveError: function(model, resp) {
      var errors = $.parseJSON(resp.responseText).errors;
      this.renderErrors(errors);
      $('#save_credentials').removeAttr('disabled');
      this.loader.hide();
      return this;
    },
    onSaveSuccess: function() {
      this.ajaxLoader('Saving');
    },
    renderErrors: function(errors) {
      var template = liftAdmin.templateLoader.getTemplate('errors');
      $('#errors').html(_.template(template, {errors: errors})).show();
      return this;
    }

  });

  liftAdmin.ModalSetCredentialsView = liftAdmin.SetCredentialsView.extend({
    _template: 'modal-set-credentials',
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate(this._template));
      this.model.settings.get('credentials').on('sync', this.closeModal, this);
    },
    events: {
      'click #cancel': 'closeModal',
      'click #save_credentials': 'updateCredentials'
    },
    onClose: function() {
      this.model.settings.get('credentials').off('sync', this.closeModal, this);
    },
    closeModal: function() {
      adminApp.closeModal(this);
    }
  });

  liftAdmin.ModalErrorSetCredentialsView = liftAdmin.SetCredentialsView.extend({
    _template: 'modal-error-set-credentials'
  });

  liftAdmin.ModalError = Backbone.View.extend({
    _template: 'modal-error',
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate(this._template));
      this.model.domains.on('reset', this.closeIfFixed, this);
    },
    render: function() {
      this.el.innerHTML = this.template({settings: this.model.settings.toJSONObject(), error: this.model.error});
      return this;
    },
    closeIfFixed: function() {
      if(!this.model.domains.error) {
        adminApp.closeModal(this);
      }
      return this;
    }
  });

  liftAdmin.ModalMissingDomain = Backbone.View.extend({
    _template: 'modal-error-missing-domain',
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate(this._template));
    },
    events: {
      'click #reset_lift': 'resetLift',
      'click #unset_domainname': 'unsetDomainName'
    },
    render: function() {
      this.el.innerHTML = this.template({settings: this.model.settings.toJSONObject(), error: this.model.error});
      return this;
    },
    resetLift: function() {
      adminApp.on('resetLift', this.closeModal, this)
          .resetLift();
      return this;
    },
    unsetDomainName: function() {
      adminApp.on('unsetDomainName', this.closeModal, this)
          .unsetDomainName();
      return this;
    },
    closeModal: function() {
      adminApp.closeModal(this);
    }
  });

  liftAdmin.SetDomainView = Backbone.View.extend({
    loadText: $('<p id="lift-load-text">'),
    loader: $('<p id="lift-ajax-loader">'),
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate('set-domain'));
    },
    events: {
      'click #save_domainname': 'setDomainname',
      'click #cancel': 'goBack',
      'keypress #domainname' : 'submitOnEnter'
    },
    ajaxLoader: function( text ) {
      this.loadText.text(text);
      this.loader.html(this.loadText);
      this.loader.show();
    },
    render: function() {
      this.el.innerHTML = this.template(this.model.settings.toJSONObject());
      $('#save_domainname').after(this.loader);
      return this;
    },
    beforeSave: function() {
      $('#errors').hide();
      $('#save_domainname').attr('disabled', 'disabled');
      return this;
    },
    afterSave: function() {
      $('#save_domainname').removeAttr('disabled');
      return this;
    },
    submitOnEnter: function(e){
      if ( 13 != e.keyCode) return;
      e.preventDefault();
      document.getElementById("save_domainname").click();
      return this;
    },
    setDomainname: function() {
      var domainname,
          domain,
          region;
      this.beforeSave();
      domainname = $('#domainname').val();
      region = $('#region').val();
      domain = this.model.domains.get(domainname);

      if (!domain) {
        //if domain doesn't exist, create it
        this.createDomain(domainname, region);
      } else {
        //have user confirm to override the existing domain
        var model = this.model.domains.get(domainname);
        this.showConfirmModal(model);
      }
      return this;
    },
    showConfirmModal: function(model) {
        var modalView = new liftAdmin.ModalConfirmDomainView({model: model});
        modalView.on('cancelled', this.modalCancelled, this);
        modalView.on('confirmed', this.modalConfirmed, this);
        adminApp.openModal(modalView);
    },
    modalCancelled: function(view) {
      $('#save_domainname').removeAttr('disabled');
      adminApp.closeModal(view);
      return this;
    },
    modalConfirmed: function(view, domain) {
      adminApp.closeModal(view);
      this.useDomain(domain);
      return this;
    },
    createDomain: function(domainname, region) {
      var domain;
      this.ajaxLoader('Creating Domain');
      domain = new liftAdmin.DomainModel({DomainName: domainname, Region: region});
      domain.nonce = this.model.domains.nonce;
      domain.on('sync', this.onCreateDomainSuccess, this);
      domain.on('error', this.onCreateDomainError, this);
      domain.save();
      return this;
    },
    onCreateDomainSuccess: function(model, resp) {
      var _this = this;
      this.ajaxLoader('Saving');
      model.off('sync', this.onCreateDomainSuccess, this);
      model.off('error', this.onCreateDomainError, this);
      if ( resp.data ) {
        var domain = new liftAdmin.DomainModel(resp.data);
        this.model.domains.add(domain);
        this.useDomain(domain);
      } else {
        this.ajaxLoader('Waiting for Amazon to initialize domain');
        this.model.domains.on('sync', function(){
          domain = this.model.domains.get(model);
          if (domain) {
            _this.useDomain(domain);
          }
        }, this)
        this.model.domains.enablePolling();
      }
    },
    onCreateDomainError: function(model, resp) {
      var errors = $.parseJSON(resp.responseText).errors;
      this.loader.hide();
      model.off('sync', this.onCreateDomainSuccess, this);
      model.off('error', this.onCreateDomainError, this);
      if ( errors[0].code === 'domain_exists' ) {
        this.model.domains.add(model);
        this.showConfirmModal(model);
      } else {
        this.renderErrors(errors).afterSave();
      }

    },
    renderErrors: function(errors) {
      var template = liftAdmin.templateLoader.getTemplate('errors');
      $('#errors').html(_.template(template, {errors: errors})).show();
      return this;
    },
    goBack: function() {
      adminApp.renderState('set_credentials');
      return this;
    },
    useDomain: function(domain) {
      adminApp.settings.get('domainname').save({value: domain.get('DomainName'), region: $('#region').val()});
      return this;
    }
  });

  liftAdmin.ModalConfirmDomainView = Backbone.View.extend({
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate('modal-confirm-domain'));
    },
    events: {
      'click #confirm_domain': 'confirm',
      'click #cancel_domain': 'cancel'
    },
    render: function() {
      this.el.innerHTML = this.template(this.model.toJSON());
      return this;
    },
    confirm: function() {
      this.trigger('confirmed', this, this.model);
      return this;
    },
    cancel: function() {
      this.trigger('cancelled', this, this.model);
      return this;
    }

  });

  liftAdmin.SetupProcessingView = Backbone.View.extend({
    initialize: function() {
      this.template = _.template(liftAdmin.templateLoader.getTemplate('setup-processing'));
      this.model.domains.on('reset', this.render, this);
    },
    render: function() {
      var domain = this.model.domains.get(this.model.settings.getValue('domainname')),
          errorModal;
      if (domain.get('Deleted')) {
        errorModal = new liftAdmin.ModalMissingDomain({model: this.model});
        adminApp.openModal(errorModal);
      }
      if (!domain || domain.get('DocService').EndPoint) {
        adminApp.render();
        return this;
      }

      this.el.innerHTML = this.template(domain.toJSON());
      return this;
    },
    onClose: function() {
      this.model.domains.off('reset', this.render, this);
      return this;
    }

  });

  var adminApp = new liftAdmin.App();

})(jQuery, window);

(function($) {
  $.fn.liftPaginator = function(options) {
    var defaults, settings;

    var getPaginationLink = function(pageNum, currentPage) {
      if (pageNum === currentPage) {
        return '<span class="page-numbers current">' + pageNum + '</span>';
      }
      return '<a class="page-numbers" href="#' + pageNum + '">' + pageNum + '</a>';
    };

    defaults = {
      totalPages: 1,
      currentPage: 1,
      midSize: 1,
      endSize: 2
    };

    settings = $.extend(defaults, options);

    return this.each(function() {
      var $this = $(this),
          links = [],
          i,
          loopTil;

      if (settings.totalPages > 1) {

        if (settings.currentPage > 1) {
          links.push('<a class="next page-numbers" href="' + (settings.currentPage - 1) + '">&laquo; Previous</a></span>');
        }

        for (i = 1, loopTil = 1 + settings.endSize; i < loopTil; i+=1) {
          links.push(getPaginationLink(i, settings.currentPage));
        }

        if (i < settings.currentPage - settings.midSize) {
          links.push('<span class="page-numbers dots">…</span>');
        }

        i = Math.max(i, settings.currentPage - settings.midSize);
        loopTil = Math.min(settings.currentPage + settings.midSize + 1, settings.totalPages - settings.endSize + 1);

        if (i < loopTil) {
          for (; i < loopTil; i+=1) {
            links.push(getPaginationLink(i, settings.currentPage));
          }
        }

        if (i < settings.totalPages - settings.endSize + 1) {
          links.push('<span class="page-numbers dots">…</span>');
        }


        i = Math.max(i, settings.totalPages - settings.endSize + 1);
        for (; i <= settings.totalPages; i+=1) {
          links.push(getPaginationLink(i, settings.currentPage));
        }

        if (settings.currentPage < settings.totalPages) {
          links.push('<a class="next page-numbers" href="' + (settings.currentPage + 1) + '">Next &raquo;</a></span>');
        }
        $this.append('<span class="pagination-links">' + links.join('') + '</span>');

      }
    });
  };
})(jQuery);